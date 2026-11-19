import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { generateLibrary } from './fake-immich.js';
import { Browser, startStack } from './helpers.js';

const library = generateLibrary({ months: 3, now: new Date('2026-11-18T12:00:00Z') });
let stack;
let browser;

before(async () => {
    stack = await startStack({ library });
});
after(() => stack.close());
beforeEach(() => {
    browser = new Browser(stack.baseUrl);
    stack.fake.requests.length = 0;
});

const lastRequest = path => stack.fake.requests.findLast(r => r.path === path);

describe('sign-in', () => {
    test('the start page sends signed-out visitors to sign in', async () => {
        const response = await browser.request('/');
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), '/auth/login');
    });

    test('runs Immich OAuth with PKCE and returns to the requested page', async () => {
        const { login, callback } = await browser.signIn('/?from=test');
        assert.equal(login.status, 302);
        const authorize = lastRequest('/api/oauth/authorize');
        assert.equal(authorize.body.redirectUri, `${stack.baseUrl}/auth/callback`);
        assert.match(authorize.body.state, /^[A-Za-z0-9_-]{32}$/);
        assert.match(authorize.body.codeChallenge, /^[A-Za-z0-9_-]{43}$/);

        assert.equal(callback.status, 303);
        assert.equal(callback.headers.get('location'), '/?from=test');
        const exchange = lastRequest('/api/oauth/callback');
        assert.ok(exchange.body.url.startsWith(`${stack.baseUrl}/auth/callback?state=`), 'sends the absolute callback URL');
        assert.equal(exchange.body.state, authorize.body.state);
        assert.ok(exchange.body.codeVerifier);
        assert.ok(browser.cookies.has('ep_session'));
        assert.ok(!browser.cookies.has('ep_login'), 'the login cookie is single-use');

        const home = await browser.request('/');
        assert.equal(home.status, 200);
        const page = await home.text();
        assert.match(page, /Test User/);
        assert.doesNotMatch(page, /type="search"|placeholder="Search/i);
        assert.equal(home.headers.get('cache-control'), 'private, no-store');
    });

    test('forwards the browser user agent so Immich can label the session', async () => {
        const login = await browser.request('/auth/login');
        await browser.request(login.headers.get('location'), { headers: { 'user-agent': 'TestBrowser/1.0' } });
        assert.equal(lastRequest('/api/oauth/callback').headers['user-agent'], 'TestBrowser/1.0');
    });

    test('rejects a callback whose state does not match the login cookie', async () => {
        const login = await browser.request('/auth/login');
        browser.cookies.set('ep_login', 'someone-elses-state');
        const callback = await browser.request(login.headers.get('location'));
        assert.equal(callback.status, 400);
        assert.ok(!browser.cookies.has('ep_session'));
        assert.equal(lastRequest('/api/oauth/callback'), undefined);
    });

    test('rejects an unknown or reused state', async () => {
        const login = await browser.request('/auth/login');
        const target = login.headers.get('location');
        const cookie = browser.cookies.get('ep_login');
        assert.equal((await browser.request(target)).status, 303);

        const replay = new Browser(stack.baseUrl);
        replay.cookies.set('ep_login', cookie);
        assert.equal((await replay.request(target)).status, 400);
    });

    test('shows an error page when the identity provider refuses', async () => {
        await browser.request('/auth/login');
        const response = await browser.request('/auth/callback?error=access_denied&state=x');
        assert.equal(response.status, 400);
        assert.match(await response.text(), /Sign-in failed/);
    });

    test('neutralizes open redirects in the return path', async () => {
        for (const returnTo of ['//evil.example/', 'https://evil.example/', '/\\evil.example']) {
            const fresh = new Browser(stack.baseUrl);
            const { callback } = await fresh.signIn(returnTo);
            assert.equal(callback.headers.get('location'), '/', returnTo);
        }
    });
});

describe('signed-in API', () => {
    beforeEach(() => browser.signIn());

    test('lists month buckets with the user token', async () => {
        const response = await browser.request('/api/timeline/buckets');
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), library.map(m => ({ month: m.month, count: m.assets.length })));
        const upstream = lastRequest('/api/timeline/buckets');
        assert.match(upstream.headers.authorization, /^Bearer /);
        assert.deepEqual(upstream.query, { visibility: 'timeline', withStacked: 'true' });
    });

    test('returns a trimmed month without location or owner data', async () => {
        const month = library[1];
        const response = await browser.request(`/api/timeline/bucket?month=${month.month}`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(Object.keys(body).sort(), ['duration', 'fileCreatedAt', 'id', 'isImage', 'localOffsetHours', 'ratio', 'stackCount']);
        assert.deepEqual(body.id, month.assets.map(a => a.id));
        assert.equal(lastRequest('/api/timeline/bucket').query.timeBucket, `${month.month}-01T00:00:00.000Z`);
    });

    test('validates the month parameter', async () => {
        for (const month of ['2026-13', '2026-1', 'x', '']) {
            assert.equal((await browser.request(`/api/timeline/bucket?month=${month}`)).status, 400, month);
        }
    });

    test('streams thumbnails and previews with private caching and revalidation', async () => {
        const id = library[0].assets[0].id;
        const thumbnail = await browser.request(`/media/${id}/thumbnail`);
        assert.equal(thumbnail.status, 200);
        assert.equal(thumbnail.headers.get('content-type'), 'image/svg+xml');
        assert.equal(thumbnail.headers.get('cache-control'), 'private, max-age=86400');
        assert.match(await thumbnail.text(), /^<svg/);
        assert.deepEqual(lastRequest(`/api/assets/${id}/thumbnail`).query, { size: 'thumbnail', edited: 'true' });

        const etag = thumbnail.headers.get('etag');
        const revalidated = await browser.request(`/media/${id}/thumbnail`, { headers: { 'if-none-match': etag } });
        assert.equal(revalidated.status, 304);

        const preview = await browser.request(`/media/${id}/preview`);
        assert.equal(preview.status, 200);
        assert.equal(lastRequest(`/api/assets/${id}/thumbnail`).query.size, 'preview');
    });

    test('refuses malformed media requests without calling Immich', async () => {
        assert.equal((await browser.request('/media/not-a-uuid/thumbnail')).status, 400);
        assert.equal((await browser.request(`/media/${library[0].assets[0].id}/original`)).status, 400);
        assert.equal((await browser.request('/media/..%2F..%2Fapi%2Fusers%2Fme/thumbnail')).status, 400);
        assert.ok(!stack.fake.requests.some(r => r.path.includes('/api/assets/')));
    });

    test('passes 404 through for unknown assets', async () => {
        assert.equal((await browser.request('/media/00000000-0000-4000-8000-000000000000/thumbnail')).status, 404);
    });

    test('ends the session when Immich no longer accepts the token', async () => {
        const countSessions = () => stack.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
        const before = countSessions();
        stack.fake.revokeAll();
        const response = await browser.request('/api/timeline/buckets');
        assert.equal(response.status, 401);
        assert.ok(!browser.cookies.has('ep_session'));
        assert.equal(countSessions(), before - 1);
        assert.equal((await browser.request('/')).status, 302);
    });
});

describe('without a session', () => {
    test('API and media answer 401', async () => {
        assert.equal((await browser.request('/api/timeline/buckets')).status, 401);
        assert.equal((await browser.request(`/media/${library[0].assets[0].id}/thumbnail`)).status, 401);
        assert.equal(stack.fake.requests.length, 0);
    });

    test('health check and static files work', async () => {
        assert.equal((await browser.request('/healthz')).status, 200);
        assert.equal((await browser.request('/static/app.js')).status, 200);
        assert.equal((await browser.request('/static/layout.js')).status, 200);
    });

    test('sends security headers', async () => {
        const response = await browser.request('/signed-out');
        assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
        assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    });
});

describe('sign-out', () => {
    test('requires a same-origin request', async () => {
        await browser.signIn();
        const response = await browser.request('/auth/logout', { method: 'POST' });
        assert.equal(response.status, 403);
        assert.equal((await browser.request('/api/timeline/buckets')).status, 200, 'still signed in');
    });

    test('ends the Immich session and the local session', async () => {
        await browser.signIn();
        assert.equal(stack.fake.tokens.size > 0, true);
        const tokensBefore = stack.fake.tokens.size;
        const response = await browser.request('/auth/logout', { method: 'POST', headers: { origin: stack.baseUrl } });
        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), '/signed-out');
        assert.ok(lastRequest('/api/auth/logout'));
        assert.equal(stack.fake.tokens.size, tokensBefore - 1);
        assert.ok(!browser.cookies.has('ep_session'));
        assert.equal((await browser.request('/api/timeline/buckets')).status, 401);
        const signedOut = await browser.request('/signed-out');
        assert.match(await signedOut.text(), /Sign in again/);
    });
});

describe('mobile API', () => {
    test('needs a valid Immich token and serves the user\'s suggestions', async () => {
        assert.equal((await fetch(`${stack.baseUrl}/api/mobile/info`).then(r => r.json())).service, 'editor-photos');
        assert.equal((await fetch(`${stack.baseUrl}/api/mobile/suggestions`)).status, 401);
        assert.equal((await fetch(`${stack.baseUrl}/api/mobile/suggestions`, { headers: { authorization: 'Bearer nope' } })).status, 401);
        const token = 'mobile-test-token';
        stack.fake.tokens.add(token);
        const res = await fetch(`${stack.baseUrl}/api/mobile/suggestions`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray((await res.json()).suggestions));
        const feedback = await fetch(`${stack.baseUrl}/api/mobile/suggestions/unknown/feedback`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'dismissed' }) });
        assert.equal(feedback.status, 404, 'no Origin header needed, unknown suggestion is 404');
    });
});
