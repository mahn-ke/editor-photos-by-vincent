import path from 'node:path';
import { loadConfig } from './src/config.js';
import { createImmichClient } from './src/immich.js';
import { createApp } from './src/server.js';
import { openStore } from './src/sessions.js';

const config = loadConfig();
const store = openStore(path.join(config.dataDir, 'sessions.sqlite'));
const immich = createImmichClient({ baseUrl: config.immichUrl });
const app = createApp({ config, store, immich });

store.prune();
setInterval(() => store.prune(), 60 * 60 * 1000).unref();

const server = app.listen(config.port, () => {
    console.log(`editor-photos listening on :${config.port} for ${config.baseUrl}, Immich at ${config.immichUrl}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => {
        store.close();
        process.exit(0);
    }));
}
