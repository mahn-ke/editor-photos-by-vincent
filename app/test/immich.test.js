import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImmichClient, ImmichError, ImmichUnauthorized, trimBucket } from '../src/immich.js';

function stubFetch(responder) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const call = { url: new URL(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
        calls.push(call);
        const { status = 200, json, headers = {} } = responder(call) ?? {};
        return new Response(json === undefined ? null : JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
    };
    return { calls, fetchImpl };
}

test('authorize posts redirect URI, state and PKCE challenge', async () => {
    const { calls, fetchImpl } = stubFetch(() => ({ status: 201, json: { url: 'https://sso.example/auth?x=1' } }));
    const immich = createImmichClient({ baseUrl: 'https://photos.example', fetchImpl });
    const url = await immich.authorize({ redirectUri: 'https://app.example/auth/callback', state: 's', codeChallenge: 'c' });
    assert.equal(url, 'https://sso.example/auth?x=1');
    assert.equal(calls[0].url.href, 'https://photos.example/api/oauth/authorize');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, { redirectUri: 'https://app.example/auth/callback', state: 's', codeChallenge: 'c' });
});

test('authorize refuses a missing or non-http URL', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 201, json: { url: 'javascript:alert(1)' } }));
    const immich = createImmichClient({ baseUrl: 'https://photos.example', fetchImpl });
    await assert.rejects(immich.authorize({ redirectUri: 'x', state: 's', codeChallenge: 'c' }), ImmichError);
});

test('callback sends the callback URL, state, verifier and user agent', async () => {
    const { calls, fetchImpl } = stubFetch(() => ({ status: 201, json: { accessToken: 'tok', userId: 'u1', userEmail: 'a@example.com', name: '' } }));
    const immich = createImmichClient({ baseUrl: 'https://photos.example', fetchImpl });
    const result = await immich.callback({ url: 'https://app.example/auth/callback?code=1&state=s', state: 's', codeVerifier: 'v', userAgent: 'UA/1' });
    assert.deepEqual(result, { accessToken: 'tok', userId: 'u1', name: 'a@example.com' });
    assert.deepEqual(calls[0].body, { url: 'https://app.example/auth/callback?code=1&state=s', state: 's', codeVerifier: 'v' });
    assert.equal(calls[0].headers['user-agent'], 'UA/1');
    assert.equal(calls[0].headers.authorization, undefined);
});

test('callback failures carry the Immich status', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 400, json: { message: 'OAuth authentication failed' } }));
    const immich = createImmichClient({ baseUrl: 'https://photos.example', fetchImpl });
    await assert.rejects(immich.callback({ url: 'u', state: 's', codeVerifier: 'v' }), error => error instanceof ImmichError && error.status === 400);
});

test('signed-in calls use the bearer token and map 401 to ImmichUnauthorized', async () => {
    const { calls, fetchImpl } = stubFetch(() => ({ status: 401, json: { message: 'Invalid user token' } }));
    const immich = createImmichClient({ baseUrl: 'https://photos.example/', fetchImpl });
    await assert.rejects(immich.buckets('tok'), ImmichUnauthorized);
    assert.equal(calls[0].headers.authorization, 'Bearer tok');
});

test('buckets are reduced to months with assets', async () => {
    const { calls, fetchImpl } = stubFetch(() => ({
        json: [{ timeBucket: '2026-11-01', count: 3 }, { timeBucket: '2026-10-01', count: 0 }, { timeBucket: 'bad', count: 2 }],
    }));
    const immich = createImmichClient({ baseUrl: 'https://photos.example', fetchImpl });
    assert.deepEqual(await immich.buckets('tok'), [{ month: '2026-11', count: 3 }]);
    assert.equal(calls[0].url.search, '?visibility=timeline&withStacked=true');
});

test('bucket requests the month start and trims columns', async () => {
    const { calls, fetchImpl } = stubFetch(() => ({
        json: {
            id: ['a', 'b'], ratio: [1.5, 0], isImage: [true, false], fileCreatedAt: ['2026-11-01T10:00:00', '2026-11-02T10:00:00'],
            localOffsetHours: [1, null], duration: [null, 4200], stack: [null, ['s', '3']],
            city: ['X', 'Y'], latitude: [1, 2], ownerId: ['o', 'o'],
        },
    }));
    const immich = createImmichClient({ baseUrl: 'https://photos.example', fetchImpl });
    const bucket = await immich.bucket('tok', '2026-11');
    assert.equal(calls[0].url.searchParams.get('timeBucket'), '2026-11-01T00:00:00.000Z');
    assert.deepEqual(bucket, {
        id: ['a', 'b'],
        ratio: [1.5, 1],
        isImage: [true, false],
        fileCreatedAt: ['2026-11-01T10:00:00', '2026-11-02T10:00:00'],
        localOffsetHours: [1, 0],
        duration: [null, 4200],
        stackCount: [0, 3],
    });
});

test('trimBucket tolerates missing columns', () => {
    assert.deepEqual(trimBucket({ id: ['a'] }), {
        id: ['a'], ratio: [1], isImage: [true], fileCreatedAt: [null], localOffsetHours: [0], duration: [null], stackCount: [0],
    });
    assert.deepEqual(trimBucket(null).id, []);
});

test('media asks for the edited thumbnail of the given size', async () => {
    const { calls, fetchImpl } = stubFetch(() => ({ status: 304 }));
    const immich = createImmichClient({ baseUrl: 'https://photos.example', fetchImpl });
    const response = await immich.media('tok', 'abc', 'preview', { ifNoneMatch: '"e"' });
    assert.equal(response.status, 304);
    assert.equal(calls[0].url.pathname, '/api/assets/abc/thumbnail');
    assert.equal(calls[0].url.search, '?size=preview&edited=true');
    assert.equal(calls[0].headers['if-none-match'], '"e"');
    assert.equal(calls[0].headers['if-modified-since'], undefined);
    assert.equal(calls[0].headers.accept, 'image/*');
    await assert.rejects(immich.media('tok', 'abc', 'original'), TypeError);
});
