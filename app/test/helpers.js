import http from 'node:http';
import { createEditor } from '../src/edits.js';
import { createImmichClient } from '../src/immich.js';
import { createRenderPool } from '../src/render.js';
import { createApp } from '../src/server.js';
import { openStore } from '../src/sessions.js';
import { startFakeImmich } from './fake-immich.js';

export const silentLog = { log() {}, info() {}, warn() {}, error() {} };

// The app's base URL must be known before it is created, so listen first
export async function startStack(options = {}) {
    const fake = await startFakeImmich(options);
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const store = openStore(':memory:');
    const immich = createImmichClient({ baseUrl: fake.url });
    const renderPool = createRenderPool();
    const events = [];
    const editor = createEditor({ immich, renderPool, log: silentLog, onEvent: e => events.push(e) });
    const app = createApp({
        config: { baseUrl, immichUrl: fake.url, port: 0, dataDir: ':memory:' },
        store,
        immich,
        editor,
        log: silentLog,
    });
    server.on('request', app);
    return {
        fake,
        store,
        baseUrl,
        events,
        editor,
        close: async () => {
            await new Promise(resolve => server.close(resolve));
            await fake.close();
            await renderPool.close();
            store.close();
        },
    };
}

// Minimal cookie jar: name → value from Set-Cookie headers; expired cookies are removed
export class Browser {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.cookies = new Map();
    }

    async request(path, { method = 'GET', headers = {} } = {}) {
        const url = path.startsWith('http') ? path : this.baseUrl + path;
        const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
        const response = await fetch(url, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers } });
        for (const header of response.headers.getSetCookie()) {
            const [pair, ...attributes] = header.split(';');
            const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
            const expired = attributes.some(a => /^\s*expires=Thu, 01 Jan 1970/i.test(a)) || attributes.some(a => /^\s*max-age=0\s*$/i.test(a));
            if (expired || !value) this.cookies.delete(name);
            else this.cookies.set(name, value);
        }
        return response;
    }

    // Follows the full sign-in: app → (fake) Immich authorize → app callback
    async signIn(returnTo = '/') {
        const login = await this.request(`/auth/login?return=${encodeURIComponent(returnTo)}`);
        const callback = await this.request(login.headers.get('location'));
        return { login, callback };
    }
}
