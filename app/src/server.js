import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ImmichUnauthorized, MEDIA_SIZES } from './immich.js';
import { SESSION_IDLE_MS } from './sessions.js';
import { appPage, editorPage, messagePage } from './views.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SESSION_COOKIE = 'ep_session';
const LOGIN_COOKIE = 'ep_login';
const LOGIN_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function safeReturnPath(value) {
    return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/';
}

function parseCookies(header = '') {
    const cookies = {};
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        try {
            cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
        } catch {
            // Ignore cookies that are not ours and not URI-encoded
        }
    }
    return cookies;
}

function sameToken(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && timingSafeEqual(left, right);
}

export function createApp({ config, store, immich, editor = null, background = null, suggester = null, log = console }) {
    const app = express();
    const secure = config.baseUrl.startsWith('https://');
    const sessionCookieOptions = { httpOnly: true, secure, sameSite: 'lax', path: '/' };
    const loginCookieOptions = { httpOnly: true, secure, sameSite: 'lax', path: '/auth' };
    const redirectUri = `${config.baseUrl}/auth/callback`;

    app.disable('x-powered-by');
    app.set('trust proxy', true);

    app.use((req, res, next) => {
        res.set({
            'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
        });
        next();
    });

    app.get('/healthz', (req, res) => res.type('text').send('ok'));
    app.use('/static', express.static(PUBLIC_DIR, { maxAge: '1h' }));

    app.use((req, res, next) => {
        req.cookies = parseCookies(req.headers.cookie);
        req.session = store.getSession(req.cookies[SESSION_COOKIE]);
        // HTML and JSON are per user; media sets its own private caching
        if (!req.path.startsWith('/media/')) res.set('Cache-Control', 'private, no-store');
        next();
    });

    // Immich's workflow webhook (server-to-server, so no Origin header): only a per-user secret
    app.post('/hooks/immich/:userId', express.json({ limit: '1mb' }), (req, res) => {
        if (!background || !background.verifyWebhook(req.params.userId, req.get('x-editor-photos-secret'))) return res.status(403).json({ error: 'forbidden' });
        background.onWebhook(req.params.userId, req.body);
        res.status(202).json({ ok: true });
    });

    // State-changing requests must come from our own pages
    app.use((req, res, next) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
        if (req.get('origin') !== config.baseUrl) return res.status(403).type('text').send('Cross-origin request refused');
        next();
    });

    const endSession = (req, res) => {
        store.deleteSession(req.cookies[SESSION_COOKIE]);
        res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
    };

    const page = (res, status, view) => res.status(status).type('html').send(view);

    const requireSession = (req, res, next) => {
        if (req.session) return next();
        res.status(401).json({ error: 'signed_out' });
    };

    // An Immich 401 means the Immich session ended (sign-out elsewhere, expiry, revocation)
    const asUser = handler => async (req, res, next) => {
        try {
            await handler(req, res);
        } catch (error) {
            if (error instanceof ImmichUnauthorized) {
                endSession(req, res);
                if (!res.headersSent) res.status(401).json({ error: 'signed_out' });
                return;
            }
            next(error);
        }
    };

    const jsonBody = express.json({ limit: '256kb' });
    const editorRoute = handler => asUser(async (req, res) => {
        if (!editor) return res.status(503).json({ error: 'editor_unavailable' });
        try {
            await handler(req, res);
        } catch (error) {
            if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
            throw error;
        }
    });
    const assetParam = (req, res) => {
        if (UUID.test(req.params.id)) return req.params.id;
        res.status(400).json({ error: 'invalid_asset' });
        return null;
    };

    app.get('/', (req, res) => {
        if (!req.session) return res.redirect(302, '/auth/login');
        page(res, 200, appPage({ name: req.session.name }));
    });

    app.get('/signed-out', (req, res) => {
        if (req.session) return res.redirect(302, '/');
        page(res, 200, messagePage({
            title: 'Signed out',
            message: 'You are signed out of Photos.',
            action: { href: '/auth/login', label: 'Sign in again' },
        }));
    });

    app.get('/auth/login', async (req, res, next) => {
        try {
            const state = randomBytes(24).toString('base64url');
            const verifier = randomBytes(32).toString('base64url');
            const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
            const url = await immich.authorize({ redirectUri, state, codeChallenge });
            store.saveLoginState(state, { verifier, returnTo: safeReturnPath(req.query.return) });
            res.cookie(LOGIN_COOKIE, state, { ...loginCookieOptions, maxAge: LOGIN_COOKIE_MAX_AGE_MS });
            res.redirect(302, url);
        } catch (error) {
            next(error);
        }
    });

    app.get('/auth/callback', async (req, res, next) => {
        const { state, error } = req.query;
        const expectedState = req.cookies[LOGIN_COOKIE];
        res.clearCookie(LOGIN_COOKIE, loginCookieOptions);
        const retry = { href: '/auth/login', label: 'Try again' };

        if (typeof error === 'string') {
            return page(res, 400, messagePage({ title: 'Sign-in failed', message: 'The sign-in was cancelled or refused.', action: retry }));
        }
        const login = typeof state === 'string' && expectedState && sameToken(state, expectedState) ? store.takeLoginState(state) : null;
        if (!login) {
            return page(res, 400, messagePage({ title: 'Sign-in expired', message: 'This sign-in link is invalid or has expired.', action: retry }));
        }

        try {
            const result = await immich.callback({
                url: config.baseUrl + req.originalUrl,
                state,
                codeVerifier: login.verifier,
                userAgent: req.get('user-agent'),
            });
            const cookie = store.createSession({ token: result.accessToken, userId: result.userId, name: result.name });
            // Set up (or check) the background API key without delaying the sign-in
            background?.ensureUser(result.accessToken, result.userId).catch(error => log.warn(`Background setup failed: ${error.message}`));
            res.cookie(SESSION_COOKIE, cookie, { ...sessionCookieOptions, maxAge: SESSION_IDLE_MS });
            res.redirect(303, login.returnTo);
        } catch (callbackError) {
            if (callbackError.status >= 400 && callbackError.status < 500) {
                log.warn(`Immich refused a sign-in: ${callbackError.message}`);
                return page(res, 403, messagePage({
                    title: 'Sign-in refused',
                    message: 'Immich did not accept this account. Ask the administrator to create or link your Immich user.',
                    action: retry,
                }));
            }
            next(callbackError);
        }
    });

    app.post('/auth/logout', async (req, res) => {
        if (req.session) {
            try {
                await immich.logout(req.session.token);
            } catch (error) {
                if (!(error instanceof ImmichUnauthorized)) log.warn(`Immich sign-out failed: ${error.message}`);
            }
        }
        endSession(req, res);
        res.redirect(303, '/signed-out');
    });

    app.get('/api/background', requireSession, (req, res) => {
        res.json(background ? background.status(req.session.userId) : { enabled: false });
    });

    app.post('/background/unstack-raw', requireSession, asUser(async (req, res) => {
        const undone = background ? await background.unstackRawPairs(req.session.token, req.session.userId) : 0;
        page(res, 200, messagePage({ title: 'RAW pairs unstacked', message: `${undone} RAW+JPEG stacks created by this app were removed. New pairs are no longer stacked until you turn background work on again.`, action: { href: '/', label: 'Back to photos' } }));
        await background?.disableUser(req.session.token, req.session.userId);
    }));

    app.post('/background/stop', requireSession, asUser(async (req, res) => {
        await background?.disableUser(req.session.token, req.session.userId);
        page(res, 200, messagePage({ title: 'Background work stopped', message: 'The app deleted its Immich API key and upload webhook. Signing in again turns it back on.', action: { href: '/', label: 'Back to photos' } }));
    }));

    // ---- Suggestions ----

    app.get('/api/suggestions', requireSession, (req, res) => {
        if (!suggester) return res.json({ suggestions: [] });
        res.json(suggester.greeting(req.session.userId));
    });

    app.get('/api/suggestions/:id', requireSession, (req, res) => {
        const row = suggester?.get(req.session.userId, req.params.id);
        if (!row) return res.status(404).json({ error: 'not_found' });
        res.json({ id: row.id, assetId: row.asset_id, name: row.name, why: row.why, recipe: row.recipe, status: row.status });
    });

    app.get('/api/suggestions/:id/:which', requireSession, (req, res) => {
        if (!['before', 'after'].includes(req.params.which)) return res.status(404).json({ error: 'not_found' });
        const bytes = suggester?.preview(req.session.userId, req.params.id, req.params.which);
        if (!bytes) return res.status(404).json({ error: 'not_found' });
        res.set('Cache-Control', 'private, max-age=86400').type('image/jpeg').send(bytes);
    });

    app.post('/api/suggestions/:id/apply', requireSession, jsonBody, editorRoute(async (req, res) => {
        const row = suggester?.get(req.session.userId, req.params.id);
        if (!row || row.status !== 'ready') return res.status(404).json({ error: 'not_found' });
        suggester.setStatus(row.id, 'applying');
        const userId = req.session.userId;
        const job = editor.startSave({
            token: req.session.token, userId, originalId: row.asset_id, recipe: row.recipe, source: 'suggestion',
            onDone: () => suggester.accepted(userId, row.id, row.recipe),
        });
        res.status(202).json({ jobId: job.id });
    }));

    app.post('/api/suggestions/:id/dismiss', requireSession, (req, res) => {
        if (!suggester?.dismiss(req.session.userId, req.params.id)) return res.status(404).json({ error: 'not_found' });
        res.json({ ok: true });
    });

    app.post('/api/background/check', requireSession, (req, res) => {
        background?.enqueue(req.session.userId, 'poll');
        res.json({ ok: true });
    });

    app.get('/api/timeline/buckets', requireSession, asUser(async (req, res) => {
        res.json(await immich.buckets(req.session.token));
    }));

    app.get('/api/timeline/bucket', requireSession, asUser(async (req, res) => {
        const { month } = req.query;
        if (typeof month !== 'string' || !MONTH.test(month)) return res.status(400).json({ error: 'invalid_month' });
        res.json(await immich.bucket(req.session.token, month));
    }));

    // ---- Editor ----

    app.get('/edit/:id', (req, res) => {
        if (!UUID.test(req.params.id)) return page(res, 404, messagePage({ title: 'Not found', message: 'This photo does not exist.', action: { href: '/', label: 'Back to photos' } }));
        if (!req.session) return res.redirect(302, `/auth/login?return=${encodeURIComponent(`/edit/${req.params.id}`)}`);
        page(res, 200, editorPage({ assetId: req.params.id, name: req.session.name }));
    });

    app.get('/api/edit/:id', requireSession, editorRoute(async (req, res) => {
        const id = assetParam(req, res);
        if (id) res.json(await editor.context(req.session.token, id));
    }));

    app.post('/api/edit/:id/save', requireSession, jsonBody, editorRoute(async (req, res) => {
        const id = assetParam(req, res);
        if (!id) return;
        const originalId = await editor.resolveOriginal(req.session.token, id);
        const suggestionId = typeof req.body?.suggestionId === 'string' ? req.body.suggestionId : null;
        const suggestion = suggestionId && suggester ? suggester.get(req.session.userId, suggestionId) : null;
        const userId = req.session.userId;
        const recipe = req.body?.recipe;
        const job = editor.startSave({
            token: req.session.token, userId, originalId, recipe, source: suggestion ? 'suggestion' : 'manual',
            onDone: suggestion ? () => suggester.accepted(userId, suggestion.id, recipe) : null,
        });
        res.status(202).json({ jobId: job.id });
    }));

    app.get('/api/jobs/:id', requireSession, (req, res) => {
        const job = editor?.job(req.params.id, req.session.userId);
        if (!job) return res.status(404).json({ error: 'not_found' });
        res.json(job);
    });

    app.post('/api/edit/:id/discard', requireSession, jsonBody, editorRoute(async (req, res) => {
        const id = assetParam(req, res);
        if (!id) return;
        const editId = req.body?.all === true ? 'all' : req.body?.editId;
        if (typeof editId !== 'string') return res.status(400).json({ error: 'invalid_edit' });
        const originalId = await editor.resolveOriginal(req.session.token, id);
        res.json(await editor.discard(req.session.token, originalId, editId, req.session.userId));
    }));

    app.post('/api/edit/:id/show', requireSession, jsonBody, editorRoute(async (req, res) => {
        const id = assetParam(req, res);
        if (!id) return;
        const editId = req.body?.editId ?? null;
        if (editId !== null && typeof editId !== 'string') return res.status(400).json({ error: 'invalid_edit' });
        const originalId = await editor.resolveOriginal(req.session.token, id);
        await editor.show(req.session.token, originalId, editId);
        res.json({ ok: true });
    }));

    app.get('/media/:id/:size', requireSession, asUser(async (req, res) => {
        const { id, size } = req.params;
        if (!UUID.test(id) || !MEDIA_SIZES.has(size)) return res.status(400).json({ error: 'invalid_media' });

        const upstream = await immich.media(req.session.token, id, size, {
            ifNoneMatch: req.get('if-none-match'),
            ifModifiedSince: req.get('if-modified-since'),
        });
        const passHeaders = () => {
            res.set('Cache-Control', 'private, max-age=86400');
            for (const name of ['etag', 'last-modified']) {
                const value = upstream.headers.get(name);
                if (value) res.set(name, value);
            }
        };
        if (upstream.status === 304) {
            passHeaders();
            return res.status(304).end();
        }
        const type = upstream.headers.get('content-type') || '';
        if (!upstream.ok || !type.startsWith('image/') || !upstream.body) {
            await upstream.body?.cancel();
            const status = upstream.status === 404 ? 404 : 502;
            return res.status(status).json({ error: status === 404 ? 'not_found' : 'upstream_error' });
        }
        passHeaders();
        res.type(type);
        const length = upstream.headers.get('content-length');
        if (length) res.set('Content-Length', length);
        try {
            await pipeline(Readable.fromWeb(upstream.body), res);
        } catch (error) {
            // The browser cancelled the image (scrolled past it); nothing left to answer
            if (!res.headersSent) throw error;
        }
    }));

    app.use((req, res) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) return res.status(404).json({ error: 'not_found' });
        page(res, 404, messagePage({ title: 'Not found', message: 'This page does not exist.', action: { href: '/', label: 'Back to photos' } }));
    });

    app.use((error, req, res, next) => {
        log.error(`${req.method} ${req.path} failed: ${error.message}`);
        if (res.headersSent) return next(error);
        if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) return res.status(502).json({ error: 'upstream_error' });
        page(res, 502, messagePage({
            title: 'Photos are unavailable',
            message: 'Immich could not be reached. Try again in a moment.',
            action: { href: req.path.startsWith('/auth/') ? '/auth/login' : '/', label: 'Try again' },
        }));
    });

    return app;
}
