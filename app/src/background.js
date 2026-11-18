// Background work per signed-in user, done with a limited Immich API key the app creates
// at sign-in: stacking RAW+JPEG pairs and (later) preparing edit suggestions.
//
// Triggers: an Immich workflow webhook on new uploads (production), a 15-minute poll
// of recent uploads (always; the only trigger when running on localhost), and startup.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { matchPair, pairKey, stackPair } from './raw-pairs.js';

export const BACKGROUND_PERMISSIONS = ['asset.read', 'asset.view', 'asset.download', 'timeline.read', 'stack.create', 'stack.read', 'stack.update'];
const KEY_NAME = 'editor.photos background';
const POLL_MS = 15 * 60 * 1000;
const PAIR_WAIT_MS = 10 * 60 * 1000;

export function loadMasterKey({ secret, dataDir }) {
    if (secret) return Buffer.from(secret, secret.length === 64 ? 'hex' : 'base64url').subarray(0, 32);
    if (dataDir === ':memory:') return randomBytes(32);
    const file = path.join(dataDir, 'master.key');
    if (!existsSync(file)) {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600 });
    }
    return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url');
}

const seal = (key, text) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
};
const open = (key, blob) => {
    const buf = Buffer.from(blob);
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
};

export function createBackground({ db, immich, config, masterKey, log = console, now = Date.now, handlers = {} }) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS bg_users (
            user_id TEXT PRIMARY KEY,
            api_key_id TEXT,
            api_key BLOB,
            workflow_id TEXT,
            webhook_secret TEXT,
            last_poll TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bg_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            asset_id TEXT NOT NULL DEFAULT '',
            run_after INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            first_seen INTEGER NOT NULL,
            UNIQUE (user_id, kind, asset_id)
        );
        CREATE TABLE IF NOT EXISTS bg_raw_stacks (
            user_id TEXT NOT NULL,
            stack_id TEXT NOT NULL,
            jpeg_id TEXT NOT NULL,
            raw_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, raw_id)
        );
    `);
    const q = {
        user: db.prepare('SELECT * FROM bg_users WHERE user_id = ?'),
        users: db.prepare('SELECT * FROM bg_users WHERE enabled = 1 AND api_key IS NOT NULL'),
        upsertKey: db.prepare(`INSERT INTO bg_users (user_id, api_key_id, api_key, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET api_key_id = excluded.api_key_id, api_key = excluded.api_key, enabled = 1`),
        setWorkflow: db.prepare('UPDATE bg_users SET workflow_id = ? WHERE user_id = ?'),
        setPoll: db.prepare('UPDATE bg_users SET last_poll = ? WHERE user_id = ?'),
        disable: db.prepare('UPDATE bg_users SET enabled = 0, api_key = NULL, api_key_id = NULL, workflow_id = NULL WHERE user_id = ?'),
        enqueue: db.prepare(`INSERT INTO bg_jobs (user_id, kind, asset_id, run_after, first_seen) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, kind, asset_id) DO UPDATE SET run_after = MIN(run_after, excluded.run_after)`),
        next: db.prepare('SELECT * FROM bg_jobs WHERE run_after <= ? ORDER BY run_after LIMIT 1'),
        done: db.prepare('DELETE FROM bg_jobs WHERE id = ?'),
        retry: db.prepare('UPDATE bg_jobs SET run_after = ?, attempts = attempts + 1 WHERE id = ?'),
        pending: db.prepare('SELECT kind, COUNT(*) AS n FROM bg_jobs WHERE user_id = ? GROUP BY kind'),
        rawStack: db.prepare('INSERT OR REPLACE INTO bg_raw_stacks (user_id, stack_id, jpeg_id, raw_id, created_at) VALUES (?, ?, ?, ?, ?)'),
        rawStacks: db.prepare('SELECT * FROM bg_raw_stacks WHERE user_id = ?'),
        dropRawStack: db.prepare('DELETE FROM bg_raw_stacks WHERE user_id = ? AND raw_id = ?'),
    };
    const webhooksEnabled = config.baseUrl.startsWith('https://');
    let timer = null;
    let running = false;
    let stopped = false;

    const authFor = row => ({ apiKey: open(masterKey, row.api_key) });

    function enqueue(userId, kind, assetId = '', delayMs = 0) {
        q.enqueue.run(userId, kind, assetId, now() + delayMs, now());
        schedule(delayMs ? Math.min(delayMs, 1000) : 0);
    }

    // Called after a successful sign-in, with the user's session token (never stored)
    async function ensureUser(token, userId) {
        let row = q.user.get(userId);
        if (row?.api_key && row.enabled) {
            try {
                await immich.me(authFor(row));
            } catch {
                row = null; // key revoked in Immich: make a new one
            }
        }
        if (!row?.api_key || !row.enabled) {
            const key = await immich.createApiKey(token, KEY_NAME, BACKGROUND_PERMISSIONS);
            q.upsertKey.run(userId, key.id, seal(masterKey, key.secret), row?.webhook_secret ?? randomBytes(24).toString('base64url'), now());
            row = q.user.get(userId);
            enqueue(userId, 'raw-backfill');
            log.info?.(`Background processing enabled for user ${userId}`);
        }
        if (webhooksEnabled && !row.workflow_id) {
            const workflow = await immich.createWorkflow(token, {
                name: 'editor.photos: new uploads',
                description: 'Notifies editor.photos.by.vincent.mahn.ke about new uploads (RAW pairing, edit suggestions)',
                trigger: 'AssetMetadataExtraction',
                enabled: true,
                steps: [{ method: 'immich-plugin-core#webhook', config: { url: `${config.baseUrl}/hooks/immich/${userId}`, method: 'POST', headerName: 'X-Editor-Photos-Secret', headerValue: row.webhook_secret } }],
            });
            q.setWorkflow.run(workflow.id, userId);
        }
        enqueue(userId, 'poll');
    }

    async function disableUser(token, userId) {
        const row = q.user.get(userId);
        if (!row) return;
        if (row.workflow_id) await immich.deleteWorkflow(token, row.workflow_id).catch(() => {});
        if (row.api_key_id) await immich.deleteApiKey(token, row.api_key_id).catch(() => {});
        q.disable.run(userId);
    }

    function verifyWebhook(userId, secret) {
        const row = q.user.get(userId);
        if (!row?.enabled || !row.webhook_secret || typeof secret !== 'string') return false;
        const a = Buffer.from(row.webhook_secret);
        const b = Buffer.from(secret);
        return a.length === b.length && timingSafeEqual(a, b);
    }

    function onWebhook(userId, payload) {
        const asset = payload?.data?.asset;
        if (!asset?.id || typeof asset.id !== 'string') return false;
        enqueue(userId, 'new-asset', asset.id);
        return true;
    }

    // ---- Job handlers ----

    async function rawBackfill(userId, auth) {
        const dngs = [];
        for (let page = 1; page; ) {
            const { items, nextPage } = await immich.searchMetadata(auth, { originalFileName: '.dng', size: 500, page, withExif: true });
            dngs.push(...items.filter(a => a.ownerId === undefined || a.ownerId === userId));
            page = nextPage ? Number(nextPage) : null;
        }
        let stacked = 0;
        for (const raw of dngs) {
            if (pairKey(raw.originalFileName)?.part === 'raw' && !raw.stack) enqueue(userId, 'pair', raw.id);
        }
        log.info?.(`RAW backfill for ${userId}: ${dngs.length} DNGs, ${dngs.filter(d => !d.stack).length} not stacked yet`);
        return stacked;
    }

    async function pair(userId, auth, assetId, firstSeen) {
        const asset = await immich.asset(auth, assetId);
        const key = pairKey(asset.originalFileName);
        if (!key) return 'not-a-pair';
        const { items } = await immich.searchMetadata(auth, { originalFileName: key.base, size: 20, withExif: true });
        // Search results lack stack details: re-read the two halves
        const candidates = await Promise.all(items.filter(a => a.ownerId === undefined || a.ownerId === userId).map(a => immich.asset(auth, a.id)));
        const match = matchPair(candidates, key);
        if (!match) {
            if (now() - firstSeen < PAIR_WAIT_MS) return 'wait';
            return 'no-partner';
        }
        const result = await stackPair(immich, auth, match);
        if (result.status === 'stacked') q.rawStack.run(userId, result.stackId, match.jpeg.id, match.raw.id, now());
        return result.status;
    }

    async function poll(userId, auth, row) {
        const since = row.last_poll ? new Date(new Date(row.last_poll).getTime() - 10 * 60 * 1000) : new Date(now() - 24 * 3600 * 1000);
        const started = new Date(now()).toISOString();
        for (let page = 1; page; ) {
            const { items, nextPage } = await immich.searchMetadata(auth, { createdAfter: since.toISOString(), size: 500, page });
            for (const a of items) if (a.ownerId === undefined || a.ownerId === userId) enqueue(userId, 'new-asset', a.id);
            page = nextPage ? Number(nextPage) : null;
        }
        q.setPoll.run(started, userId);
        enqueue(userId, 'poll', '', POLL_MS);
    }

    async function runJob(job) {
        const row = q.user.get(job.user_id);
        if (!row?.enabled || !row.api_key) return 'disabled';
        const auth = authFor(row);
        if (job.kind === 'poll') return poll(job.user_id, auth, row);
        if (job.kind === 'raw-backfill') return rawBackfill(job.user_id, auth);
        if (job.kind === 'pair') return pair(job.user_id, auth, job.asset_id, job.first_seen);
        if (job.kind === 'new-asset') {
            const asset = await immich.asset(auth, job.asset_id).catch(() => null);
            if (!asset || asset.isTrashed) return 'gone';
            if (pairKey(asset.originalFileName)) enqueue(job.user_id, 'pair', asset.id);
            await handlers.newAsset?.(job.user_id, auth, asset);
            return 'ok';
        }
        if (handlers[job.kind]) return handlers[job.kind](job.user_id, auth, job.asset_id);
        return 'unknown';
    }

    let current = Promise.resolve();
    function work() {
        if (running || stopped) return current;
        current = drain();
        return current;
    }

    async function drain() {
        running = true;
        try {
            for (let job = q.next.get(now()); job && !stopped; job = q.next.get(now())) {
                try {
                    const outcome = await runJob(job);
                    if (outcome === 'wait') q.retry.run(now() + 120000, job.id);
                    else q.done.run(job.id);
                } catch (error) {
                    if (error.name === 'ImmichUnauthorized') {
                        log.warn(`Background key of ${job.user_id} was revoked; waiting for the next sign-in`);
                        q.disable.run(job.user_id);
                        q.done.run(job.id);
                    } else if (job.attempts >= 4) {
                        log.error(`Background ${job.kind} ${job.asset_id} failed for good: ${error.message}`);
                        q.done.run(job.id);
                    } else {
                        q.retry.run(now() + 60000 * 2 ** job.attempts, job.id);
                    }
                }
            }
        } finally {
            running = false;
        }
        schedule(30000);
    }

    function schedule(delay) {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(work, delay);
        timer.unref?.();
    }

    async function unstackRawPairs(token, userId) {
        let undone = 0;
        for (const entry of q.rawStacks.all(userId)) {
            const stack = await immich.stack(token, entry.stack_id).catch(() => null);
            if (stack) {
                const members = (stack.assets ?? []).map(a => a.id);
                if (members.length <= 2) await immich.deleteStack(token, entry.stack_id);
                else if (stack.primaryAssetId !== entry.raw_id) await immich.removeFromStack(token, entry.stack_id, entry.raw_id);
                undone++;
            }
            q.dropRawStack.run(userId, entry.raw_id);
        }
        return undone;
    }

    function status(userId) {
        const row = q.user.get(userId);
        return {
            enabled: Boolean(row?.enabled && row.api_key),
            webhook: Boolean(row?.workflow_id),
            lastPoll: row?.last_poll ?? null,
            pending: Object.fromEntries(q.pending.all(userId).map(r => [r.kind, r.n])),
            rawStacks: q.rawStacks.all(userId).length,
        };
    }

    return {
        ensureUser, disableUser, verifyWebhook, onWebhook, enqueue, unstackRawPairs, status,
        start() {
            for (const row of q.users.all()) enqueue(row.user_id, 'poll');
            schedule(0);
        },
        async stop() {
            stopped = true;
            clearTimeout(timer);
            await current;
        },
        // Waits for any run in progress, then processes everything that is due
        async runOnce() {
            await current;
            await work();
        },
    };
}
