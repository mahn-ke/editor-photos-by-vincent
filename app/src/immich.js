// Minimal Immich client for the endpoints this app needs (checked against Immich v3.4.1).
// Every call except the OAuth handshake runs as the signed-in user with their session token.

export class ImmichUnauthorized extends Error {
    constructor(message = 'The Immich session is no longer valid') {
        super(message);
        this.name = 'ImmichUnauthorized';
    }
}

export class ImmichError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'ImmichError';
        this.status = status;
    }
}

// The same filters as Immich's /photos page, minus partner photos: only the user's own
// timeline (no archive, no trash), with stacks collapsed to their primary asset
const TIMELINE_FILTERS = { visibility: 'timeline', withStacked: 'true' };
export const MEDIA_SIZES = new Set(['thumbnail', 'preview']);

// Immich answers timeline buckets in columns; keep only what the grid and viewer need.
// Location, owner, people and similar fields never leave this server.
export function trimBucket(raw) {
    const ids = Array.isArray(raw?.id) ? raw.id.map(String) : [];
    const column = (name, fallback) => ids.map((_, i) => raw[name]?.[i] ?? fallback);
    return {
        id: ids,
        ratio: column('ratio', 1).map(value => (Number(value) > 0 ? Number(value) : 1)),
        isImage: column('isImage', true).map(Boolean),
        fileCreatedAt: column('fileCreatedAt', null),
        localOffsetHours: column('localOffsetHours', 0).map(value => Number(value) || 0),
        duration: column('duration', null),
        stackCount: ids.map((_, i) => {
            const stack = raw.stack?.[i];
            return Array.isArray(stack) ? Number(stack[1]) || 0 : 0;
        }),
    };
}

export function createImmichClient({ baseUrl, fetchImpl = fetch, timeoutMs = 20000 }) {
    async function request(path, { method = 'GET', token, body, query, headers = {} } = {}) {
        const url = new URL(baseUrl + path);
        for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
        const response = await fetchImpl(url, {
            method,
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                accept: 'application/json',
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(body ? { 'content-type': 'application/json' } : {}),
                ...Object.fromEntries(Object.entries(headers).filter(([, value]) => value)),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (response.status === 401 && token) {
            await response.body?.cancel();
            throw new ImmichUnauthorized();
        }
        return response;
    }

    // Error bodies are not included: they can echo request details
    async function json(path, options = {}) {
        const response = await request(path, options);
        if (!response.ok) {
            await response.body?.cancel();
            throw new ImmichError(`Immich ${options.method || 'GET'} ${path} answered ${response.status}`, response.status);
        }
        return response.json();
    }

    return {
        async authorize({ redirectUri, state, codeChallenge }) {
            const { url } = await json('/api/oauth/authorize', { method: 'POST', body: { redirectUri, state, codeChallenge } });
            if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new ImmichError('Immich returned no sign-in URL', 502);
            return url;
        },

        // `url` must be the absolute callback URL exactly as the identity provider returned it:
        // Immich derives the token request's redirect_uri from it
        async callback({ url, state, codeVerifier, userAgent }) {
            const login = await json('/api/oauth/callback', {
                method: 'POST',
                body: { url, state, codeVerifier },
                headers: { 'user-agent': userAgent },
            });
            if (typeof login?.accessToken !== 'string' || !login.accessToken) throw new ImmichError('Immich returned no session', 502);
            return {
                accessToken: login.accessToken,
                userId: String(login.userId ?? ''),
                name: String(login.name || login.userEmail || ''),
            };
        },

        async logout(token) {
            await json('/api/auth/logout', { method: 'POST', token });
        },

        async buckets(token) {
            const list = await json('/api/timeline/buckets', { token, query: TIMELINE_FILTERS });
            if (!Array.isArray(list)) throw new ImmichError('Immich returned an invalid bucket list', 502);
            return list
                .map(bucket => ({ month: String(bucket?.timeBucket ?? '').slice(0, 7), count: Number(bucket?.count) || 0 }))
                .filter(bucket => /^\d{4}-\d{2}$/.test(bucket.month) && bucket.count > 0);
        },

        async bucket(token, month) {
            const raw = await json('/api/timeline/bucket', {
                token,
                query: { ...TIMELINE_FILTERS, timeBucket: `${month}-01T00:00:00.000Z` },
            });
            return trimBucket(raw);
        },

        // Returns the raw response so the caller can stream it; follows Immich's
        // fullsize/original redirects with the same credentials
        async media(token, id, size, conditional = {}) {
            if (!MEDIA_SIZES.has(size)) throw new TypeError(`Unsupported media size ${size}`);
            return request(`/api/assets/${encodeURIComponent(id)}/thumbnail`, {
                token,
                query: { size, edited: 'true' },
                headers: {
                    accept: 'image/*',
                    'if-none-match': conditional.ifNoneMatch,
                    'if-modified-since': conditional.ifModifiedSince,
                },
            });
        },
    };
}
