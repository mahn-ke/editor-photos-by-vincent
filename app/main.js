import path from 'node:path';
import { createBackground, loadMasterKey } from './src/background.js';
import { loadConfig } from './src/config.js';
import { createEditor } from './src/edits.js';
import { createImmichClient } from './src/immich.js';
import { createRenderPool } from './src/render.js';
import { createApp } from './src/server.js';
import { openStore } from './src/sessions.js';

const config = loadConfig();
const store = openStore(path.join(config.dataDir, 'sessions.sqlite'));
const immich = createImmichClient({ baseUrl: config.immichUrl });
const renderPool = createRenderPool();
const editor = createEditor({ immich, renderPool });
const background = createBackground({ db: store.db, immich, config, masterKey: loadMasterKey({ secret: config.appSecret, dataDir: config.dataDir }) });
const app = createApp({ config, store, immich, editor, background });
background.start();

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
