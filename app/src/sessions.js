import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

// Immich ends OAuth sessions after 90 days without use; ours follow the same rule
export const SESSION_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
const LAST_SEEN_RESOLUTION_MS = 60 * 60 * 1000;
const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_LOGIN_STATES = 1000;
const COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const sessionId = cookie => createHash('sha256').update(cookie).digest('hex');
// The key only exists in the browser's cookie: the database alone cannot reveal Immich tokens
const sessionKey = cookie => Buffer.from(hkdfSync('sha256', Buffer.from(cookie, 'base64url'), Buffer.alloc(0), 'editor-photos immich token', 32));

function encrypt(cookie, plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', sessionKey(cookie), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(cookie, blob) {
    const data = Buffer.from(blob);
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(cookie), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

export function openStore(file, { now = Date.now } = {}) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            token BLOB NOT NULL,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen INTEGER NOT NULL
        );
    `);
    const insert = db.prepare('INSERT INTO sessions (id, token, user_id, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)');
    const select = db.prepare('SELECT token, user_id, name, last_seen FROM sessions WHERE id = ?');
    const touch = db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?');
    const remove = db.prepare('DELETE FROM sessions WHERE id = ?');
    const pruneIdle = db.prepare('DELETE FROM sessions WHERE last_seen < ?');

    // Short-lived and single-use; losing them on restart only cancels a sign-in in progress
    const loginStates = new Map();
    const dropExpiredLoginStates = () => {
        for (const [state, entry] of loginStates) {
            if (entry.expiresAt <= now()) loginStates.delete(state);
        }
    };

    return {
        db,

        createSession({ token, userId, name }) {
            const cookie = randomBytes(32).toString('base64url');
            const time = now();
            insert.run(sessionId(cookie), encrypt(cookie, token), userId, name, time, time);
            return cookie;
        },

        getSession(cookie) {
            if (typeof cookie !== 'string' || !COOKIE_PATTERN.test(cookie)) return null;
            const id = sessionId(cookie);
            const row = select.get(id);
            if (!row) return null;
            const time = now();
            if (row.last_seen < time - SESSION_IDLE_MS) {
                remove.run(id);
                return null;
            }
            let token;
            try {
                token = decrypt(cookie, row.token);
            } catch {
                remove.run(id);
                return null;
            }
            if (time - row.last_seen > LAST_SEEN_RESOLUTION_MS) touch.run(time, id);
            return { token, userId: row.user_id, name: row.name };
        },

        deleteSession(cookie) {
            if (typeof cookie === 'string' && COOKIE_PATTERN.test(cookie)) remove.run(sessionId(cookie));
        },

        prune() {
            pruneIdle.run(now() - SESSION_IDLE_MS);
            dropExpiredLoginStates();
        },

        saveLoginState(state, { verifier, returnTo }) {
            dropExpiredLoginStates();
            while (loginStates.size >= MAX_LOGIN_STATES) loginStates.delete(loginStates.keys().next().value);
            loginStates.set(state, { verifier, returnTo, expiresAt: now() + LOGIN_STATE_TTL_MS });
        },

        takeLoginState(state) {
            const entry = loginStates.get(state);
            loginStates.delete(state);
            if (!entry || entry.expiresAt <= now()) return null;
            return { verifier: entry.verifier, returnTo: entry.returnTo };
        },

        close() {
            db.close();
        },
    };
}
