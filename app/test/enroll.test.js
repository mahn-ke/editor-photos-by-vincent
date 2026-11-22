import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createApp } from '../src/server.js';
import { openStore } from '../src/sessions.js';
import { silentLog } from './helpers.js';

// Sessions created before background work existed get it set up on their next request
test('an existing session without background setup is enrolled once, a disabled user is left alone', async () => {
    const store = openStore(':memory:');
    const known = new Set(['off-user']);
    const calls = [];
    const background = {
        knows: id => known.has(id),
        ensureUser: async (token, id) => { calls.push([token, id]); known.add(id); },
        status: () => ({ enabled: true }),
    };
    const app = createApp({ config: { baseUrl: 'http://x', immichUrl: 'http://y', port: 0, dataDir: ':memory:' }, store, immich: {}, background, log: silentLog });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = cookie => fetch(`${base}/api/background`, { headers: { cookie: `ep_session=${cookie}` } });
    try {
        const old = store.createSession({ token: 'old-token', userId: 'old-user', name: 'Old' });
        await get(old);
        await get(old);
        assert.deepEqual(calls, [['old-token', 'old-user']]);
        const off = store.createSession({ token: 'off-token', userId: 'off-user', name: 'Off' });
        await get(off);
        assert.equal(calls.length, 1, 'a user who turned background work off is not re-enrolled');
    } finally {
        await new Promise(resolve => server.close(resolve));
        store.close();
    }
});
