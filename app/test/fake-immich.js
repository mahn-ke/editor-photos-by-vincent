// A small stand-in for Immich's OAuth, timeline, thumbnail and logout endpoints.
// Its authorize URL points straight back at the redirect URI, as if the identity
// provider had signed the user in without a prompt. Used by the tests and `npm run dev:fake`.
import http from 'node:http';
import sharp from 'sharp';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const FAKE_USER = { id: '6b1c7a52-3f0e-4c2a-9d51-2f6e8a0c4b17', name: 'Test User', email: 'test.user@example.com' };
const ISSUER = 'https://sso.example.test/realms/test';
const RATIOS = [1.5, 0.667, 1, 1.778, 0.75, 1.333, 2.4, 0.5625];

function prng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

function uuid(random) {
    const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Months newest first, assets newest first within each month, like Immich's timeline
export function generateLibrary({ months = 6, now = new Date(), seed = 7 } = {}) {
    const random = prng(seed);
    const library = [];
    for (let m = 0; m < months; m++) {
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth() - m;
        const start = Date.UTC(year, month, 1);
        const end = Math.min(Date.UTC(year, month + 1, 1), now.getTime());
        const count = 8 + Math.floor(random() * 50);
        const times = Array.from({ length: count }, () => start + random() * (end - start)).sort((a, b) => b - a);
        const assets = times.map((time) => {
            const isImage = random() > 0.12;
            return {
                id: uuid(random),
                ratio: RATIOS[Math.floor(random() * RATIOS.length)],
                isImage,
                // Immich returns timestamps without a zone suffix
                fileCreatedAt: new Date(time).toISOString().replace('Z', ''),
                localOffsetHours: 0,
                duration: isImage ? null : Math.round(3000 + random() * 120000),
                stack: random() > 0.93 ? [uuid(random), String(2 + Math.floor(random() * 3))] : null,
            };
        });
        library.push({ month: new Date(start).toISOString().slice(0, 7), assets });
    }
    return library;
}

function columns(assets) {
    const pick = key => assets.map(asset => asset[key]);
    return {
        id: pick('id'),
        ownerId: assets.map(() => FAKE_USER.id),
        ratio: pick('ratio'),
        isFavorite: assets.map(() => false),
        visibility: assets.map(() => 'timeline'),
        isTrashed: assets.map(() => false),
        isImage: pick('isImage'),
        thumbhash: assets.map(() => null),
        createdAt: pick('fileCreatedAt'),
        fileCreatedAt: pick('fileCreatedAt'),
        localOffsetHours: pick('localOffsetHours'),
        duration: pick('duration'),
        projectionType: assets.map(() => null),
        livePhotoVideoId: assets.map(() => null),
        city: assets.map(() => 'Testville'),
        country: assets.map(() => 'Testland'),
        latitude: assets.map(() => 53.55),
        longitude: assets.map(() => 9.99),
        stack: pick('stack'),
    };
}

function placeholderSvg(asset, size) {
    const height = size === 'preview' ? 1440 : 250;
    const width = Math.round(height * asset.ratio);
    const hue = parseInt(asset.id.slice(0, 6), 16) % 360;
    const label = asset.fileCreatedAt.slice(0, 16).replace('T', ' ');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
        + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 65% 38%)"/></linearGradient></defs>`
        + `<rect width="100%" height="100%" fill="url(#g)"/>`
        + `<text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${height / 12}" text-anchor="middle" dominant-baseline="middle">${label}${asset.isImage ? '' : ' ▶'}</text></svg>`;
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const type = req.headers['content-type'] || '';
    if (type.startsWith('multipart/form-data')) {
        const form = await new Request('http://fake/upload', { method: 'POST', headers: { 'content-type': type }, body: raw }).formData();
        const fields = {};
        for (const [key, value] of form) fields[key] = typeof value === 'string' ? value : { name: value.name, bytes: Buffer.from(await value.arrayBuffer()) };
        return fields;
    }
    const text = raw.toString('utf8');
    return text ? JSON.parse(text) : {};
}

export async function startFakeImmich({ library = generateLibrary(), port = 0 } = {}) {
    const pending = new Map();
    const tokens = new Set();
    const requests = [];
    const assets = new Map(library.flatMap(month => month.assets.map(asset => [asset.id, asset])));
    const metadata = new Map(); // assetId -> Map(key -> value)
    const stacks = new Map(); // stackId -> { id, primaryAssetId, assetIds }
    const uploads = new Map(); // assetId -> bytes
    const copies = [];
    const apiKeys = new Map(); // id -> { id, secret, name, permissions }
    const workflows = new Map();
    const stackOf = id => [...stacks.values()].find(s => s.assetIds.includes(id)) ?? null;
    const assetDto = (asset) => {
        const stack = stackOf(asset.id);
        return {
            id: asset.id,
            type: asset.isImage ? 'IMAGE' : 'VIDEO',
            originalFileName: asset.originalFileName ?? `IMG_${asset.id.slice(0, 8)}.jpg`,
            originalMimeType: /\.dng$/i.test(asset.originalFileName ?? '') ? 'image/dng' : 'image/jpeg',
            width: Math.round(400 * asset.ratio),
            height: 400,
            fileCreatedAt: `${asset.fileCreatedAt}Z`,
            fileModifiedAt: `${asset.fileCreatedAt}Z`,
            createdAt: asset.createdAt ?? `${asset.fileCreatedAt}Z`,
            localDateTime: new Date(new Date(`${asset.fileCreatedAt}Z`).getTime() + 3600000).toISOString(),
            isTrashed: Boolean(asset.isTrashed),
            exifInfo: { make: 'Fake', model: 'Camera', latitude: 53.55, longitude: 9.99 },
            people: [{ id: 'p1', name: 'Should never leave the server' }],
            stack: stack ? { id: stack.id, primaryAssetId: stack.primaryAssetId, assetCount: stack.assetIds.filter(id => !assets.get(id)?.isTrashed).length } : null,
            ...(asset.dateTimeOriginal ? { dateTimeOriginal: asset.dateTimeOriginal } : {}),
        };
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://fake-immich');
        const body = req.method === 'GET' ? null : await readBody(req);
        requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
        const send = (status, payload) => {
            if (status === 204) {
                res.writeHead(204);
                return res.end();
            }
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
        };
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
        const keyHeader = req.headers['x-api-key'];
        const authedByKey = Boolean(keyHeader && [...apiKeys.values()].some(k => k.secret === keyHeader));
        const authed = Boolean(bearer && tokens.has(bearer)) || authedByKey;

        if (req.method === 'POST' && url.pathname === '/api/oauth/authorize') {
            if (!body.redirectUri || !body.state || !body.codeChallenge) return send(400, { message: 'Validation failed' });
            const code = randomBytes(8).toString('hex');
            pending.set(body.state, { redirectUri: body.redirectUri, codeChallenge: body.codeChallenge, code });
            const target = new URL(body.redirectUri);
            target.searchParams.set('state', body.state);
            target.searchParams.set('session_state', 'fake-session');
            target.searchParams.set('iss', ISSUER);
            target.searchParams.set('code', code);
            return send(201, { url: target.href });
        }

        if (req.method === 'POST' && url.pathname === '/api/oauth/callback') {
            const entry = pending.get(body.state);
            let callback;
            try {
                callback = new URL(body.url);
            } catch {
                return send(400, { message: 'Invalid callback URL' });
            }
            const challenge = createHash('sha256').update(String(body.codeVerifier || '')).digest('base64url');
            const valid = entry
                && callback.searchParams.get('state') === body.state
                && callback.searchParams.get('code') === entry.code
                && `${callback.origin}${callback.pathname}` === entry.redirectUri
                && challenge === entry.codeChallenge;
            if (!valid) return send(400, { message: 'OAuth authentication failed' });
            pending.delete(body.state);
            const accessToken = randomBytes(24).toString('base64url');
            tokens.add(accessToken);
            return send(201, {
                accessToken,
                userId: FAKE_USER.id,
                userEmail: FAKE_USER.email,
                name: FAKE_USER.name,
                profileImagePath: '',
                isAdmin: false,
                shouldChangePassword: false,
                isOnboarded: true,
            });
        }

        if (!authed) return send(401, { message: 'Invalid user token' });

        if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
            tokens.delete(bearer);
            return send(200, { successful: true, redirectUri: '/auth/login?autoLaunch=0' });
        }

        if (req.method === 'GET' && url.pathname === '/api/timeline/buckets') {
            return send(200, library.map(month => ({ timeBucket: `${month.month}-01`, count: month.assets.length })));
        }

        if (req.method === 'GET' && url.pathname === '/api/timeline/bucket') {
            const month = library.find(entry => entry.month === String(url.searchParams.get('timeBucket')).slice(0, 7));
            return send(200, columns(month ? month.assets : []));
        }

        let m;
        if (req.method === 'POST' && url.pathname === '/api/api-keys') {
            if (authedByKey) return send(403, { message: 'Session required' });
            const key = { id: randomUUID(), secret: randomBytes(20).toString('base64url'), name: body.name, permissions: body.permissions };
            apiKeys.set(key.id, key);
            return send(201, { id: key.id, name: key.name, secret: key.secret, permissions: key.permissions });
        }
        if ((m = /^\/api\/api-keys\/([^/]+)$/.exec(url.pathname)) && req.method === 'DELETE') {
            apiKeys.delete(m[1]);
            return send(204, {});
        }
        if (req.method === 'GET' && url.pathname === '/api/users/me') {
            return send(200, { id: FAKE_USER.id, name: FAKE_USER.name, email: FAKE_USER.email });
        }
        if (url.pathname === '/api/workflows' && req.method === 'POST') {
            const workflow = { id: randomUUID(), ...body };
            workflows.set(workflow.id, workflow);
            return send(201, workflow);
        }
        if ((m = /^\/api\/workflows\/([^/]+)$/.exec(url.pathname)) && req.method === 'DELETE') {
            workflows.delete(m[1]);
            return send(204, {});
        }
        if (req.method === 'POST' && url.pathname === '/api/search/metadata') {
            const all = [...assets.values()].filter(a => !a.isTrashed)
                .filter(a => !body.originalFileName || (a.originalFileName ?? '').toLowerCase().includes(body.originalFileName.toLowerCase()))
                .filter(a => !body.createdAfter || new Date(a.createdAt ?? `${a.fileCreatedAt}Z`) >= new Date(body.createdAfter))
                .filter(a => !body.takenAfter || new Date(`${a.fileCreatedAt}Z`) >= new Date(body.takenAfter))
                .filter(a => !body.takenBefore || new Date(`${a.fileCreatedAt}Z`) <= new Date(body.takenBefore));
            const size = body.size ?? 250;
            const page = body.page ?? 1;
            const items = all.slice((page - 1) * size, page * size).map(a => ({ ...assetDto(a), ownerId: FAKE_USER.id, stack: undefined }));
            return send(200, { assets: { items, nextPage: page * size < all.length ? String(page + 1) : null, count: items.length } });
        }
        if (req.method === 'POST' && url.pathname === '/api/assets') {
            const file = body.assetData;
            if (!file || !body.filename || !body.fileCreatedAt) return send(400, { message: 'Validation failed' });
            const id = randomUUID();
            assets.set(id, { id, ratio: 1.5, isImage: true, fileCreatedAt: body.fileCreatedAt.replace(/Z$/, ''), localOffsetHours: 0, duration: null, stack: null, originalFileName: body.filename });
            uploads.set(id, file.bytes);
            if (body.metadata) metadata.set(id, new Map(JSON.parse(body.metadata).map(item => [item.key, item.value])));
            return send(201, { id, status: 'created' });
        }
        if (req.method === 'PUT' && url.pathname === '/api/assets/copy') {
            copies.push(body);
            return send(204, {});
        }
        if (req.method === 'DELETE' && url.pathname === '/api/assets') {
            for (const id of body.ids || []) if (assets.has(id)) assets.get(id).isTrashed = true;
            return send(204, {});
        }
        if ((m = /^\/api\/assets\/([^/]+)\/metadata$/.exec(url.pathname))) {
            if (!assets.has(m[1])) return send(404, { message: 'Not found' });
            const map = metadata.get(m[1]) ?? new Map();
            if (req.method === 'PUT') {
                for (const item of body.items) map.set(item.key, item.value);
                metadata.set(m[1], map);
            }
            return send(200, [...map].map(([key, value]) => ({ key, value, updatedAt: new Date().toISOString() })));
        }
        if ((m = /^\/api\/assets\/([^/]+)\/metadata\/([^/]+)$/.exec(url.pathname)) && req.method === 'DELETE') {
            metadata.get(m[1])?.delete(decodeURIComponent(m[2]));
            return send(204, {});
        }
        if ((m = /^\/api\/assets\/([^/]+)\/original$/.exec(url.pathname))) {
            const asset = assets.get(m[1]);
            if (!asset) return send(404, { message: 'Not found' });
            const bytes = uploads.get(asset.id) ?? Buffer.from(placeholderSvg({ ...asset, fileCreatedAt: asset.fileCreatedAt }, 'thumbnail'));
            res.writeHead(200, { 'content-type': uploads.has(asset.id) ? 'image/jpeg' : 'image/svg+xml' });
            return res.end(bytes);
        }
        if ((m = /^\/api\/assets\/([0-9a-f-]{36})$/.exec(url.pathname))) {
            const asset = assets.get(m[1]);
            if (!asset) return send(404, { message: 'Not found' });
            if (req.method === 'PUT') Object.assign(asset, body);
            return send(200, assetDto(asset));
        }
        if (req.method === 'POST' && url.pathname === '/api/stacks') {
            const ids = body.assetIds;
            const merged = [];
            for (const id of ids) {
                const existing = stackOf(id);
                if (existing && existing.primaryAssetId === id) {
                    merged.push(...existing.assetIds);
                    stacks.delete(existing.id);
                } else if (existing) {
                    existing.assetIds = existing.assetIds.filter(a => a !== id);
                }
                merged.push(id);
            }
            const stack = { id: randomUUID(), primaryAssetId: ids[0], assetIds: [...new Set(merged)] };
            stacks.set(stack.id, stack);
            return send(201, { id: stack.id, primaryAssetId: stack.primaryAssetId });
        }
        if ((m = /^\/api\/stacks\/([^/]+)\/assets\/([^/]+)$/.exec(url.pathname)) && req.method === 'DELETE') {
            const stack = stacks.get(m[1]);
            if (!stack) return send(404, { message: 'Not found' });
            if (stack.primaryAssetId === m[2]) return send(400, { message: "Cannot remove stack's primary asset" });
            stack.assetIds = stack.assetIds.filter(id => id !== m[2]);
            return send(204, {});
        }
        if ((m = /^\/api\/stacks\/([^/]+)$/.exec(url.pathname))) {
            const stack = stacks.get(m[1]);
            if (!stack) return send(404, { message: 'Not found' });
            if (req.method === 'DELETE') {
                stacks.delete(stack.id);
                return send(204, {});
            }
            if (req.method === 'PUT') {
                if (!stack.assetIds.includes(body.primaryAssetId)) return send(400, { message: 'Not in stack' });
                stack.primaryAssetId = body.primaryAssetId;
            }
            return send(200, { id: stack.id, primaryAssetId: stack.primaryAssetId, assets: stack.assetIds.map(id => assetDto(assets.get(id))) });
        }

        const media = /^\/api\/assets\/([^/]+)\/thumbnail$/.exec(url.pathname);
        if (req.method === 'GET' && media) {
            const asset = assets.get(media[1]);
            if (!asset) return send(404, { message: 'Asset not found' });
            const size = url.searchParams.get('size') || 'thumbnail';
            const etag = `"${asset.id}-${size}"`;
            if (req.headers['if-none-match'] === etag) {
                res.writeHead(304, { etag });
                return res.end();
            }
            const svg = placeholderSvg(asset, size);
            // Previews as PNG (browsers can't decode SVG in workers), like Immich's JPEGs
            const body = size === 'preview' ? await sharp(Buffer.from(svg)).png().toBuffer() : svg;
            res.writeHead(200, {
                'content-type': size === 'preview' ? 'image/png' : 'image/svg+xml',
                'content-length': Buffer.byteLength(body),
                'cache-control': 'private, max-age=86400, no-transform',
                etag,
            });
            return res.end(body);
        }

        send(404, { message: 'Not found' });
    });

    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        library,
        requests,
        tokens,
        revokeAll: () => tokens.clear(),
        assets,
        metadata,
        stacks,
        uploads,
        copies,
        stackOf,
        apiKeys,
        workflows,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}
