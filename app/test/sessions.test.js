import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore, SESSION_IDLE_MS } from '../src/sessions.js';

const TOKEN = 'immich-session-token-0123456789abcdef';

test('stores the Immich token encrypted and keyed by a hash of the cookie', () => {
    const store = openStore(':memory:');
    const cookie = store.createSession({ token: TOKEN, userId: 'u1', name: 'Test User' });
    assert.match(cookie, /^[A-Za-z0-9_-]{43}$/);

    const rows = store.db.prepare('SELECT id, token FROM sessions').all();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].id, cookie);
    assert.ok(!Buffer.from(rows[0].token).includes(Buffer.from(TOKEN)), 'token is not stored in plaintext');

    assert.deepEqual(store.getSession(cookie), { token: TOKEN, userId: 'u1', name: 'Test User' });
    store.close();
});

test('unknown, malformed or tampered cookies find no session', () => {
    const store = openStore(':memory:');
    const cookie = store.createSession({ token: TOKEN, userId: 'u1', name: 'Test User' });
    assert.equal(store.getSession(undefined), null);
    assert.equal(store.getSession('short'), null);
    assert.equal(store.getSession(`${cookie.slice(0, -1)}${cookie.endsWith('A') ? 'B' : 'A'}`), null);

    // A row copied under another cookie's id cannot be decrypted with that cookie
    const other = store.createSession({ token: 'other', userId: 'u2', name: 'Other' });
    const otherId = store.db.prepare('SELECT id FROM sessions WHERE user_id = ?').get('u2').id;
    const stolen = store.db.prepare('SELECT token FROM sessions WHERE user_id = ?').get('u1').token;
    store.db.prepare('UPDATE sessions SET token = ? WHERE id = ?').run(stolen, otherId);
    assert.equal(store.getSession(other), null);
    store.close();
});

test('sessions end after 90 idle days, and use extends them', () => {
    let now = Date.UTC(2026, 0, 1);
    const store = openStore(':memory:', { now: () => now });
    const active = store.createSession({ token: 'a', userId: 'u1', name: 'A' });
    const idle = store.createSession({ token: 'b', userId: 'u2', name: 'B' });

    now += SESSION_IDLE_MS - 1000;
    assert.ok(store.getSession(active));
    now += 2000;
    store.prune();
    assert.ok(store.getSession(active), 'recent use keeps the session');
    assert.equal(store.getSession(idle), null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
    store.close();
});

test('deleteSession removes only that session', () => {
    const store = openStore(':memory:');
    const a = store.createSession({ token: 'a', userId: 'u1', name: 'A' });
    const b = store.createSession({ token: 'b', userId: 'u2', name: 'B' });
    store.deleteSession(a);
    assert.equal(store.getSession(a), null);
    assert.ok(store.getSession(b));
    store.close();
});

test('login states are single-use and expire after 10 minutes', () => {
    let now = 0;
    const store = openStore(':memory:', { now: () => now });
    store.saveLoginState('s1', { verifier: 'v1', returnTo: '/' });
    assert.deepEqual(store.takeLoginState('s1'), { verifier: 'v1', returnTo: '/' });
    assert.equal(store.takeLoginState('s1'), null);

    store.saveLoginState('s2', { verifier: 'v2', returnTo: '/' });
    now += 10 * 60 * 1000;
    assert.equal(store.takeLoginState('s2'), null);
    store.close();
});
