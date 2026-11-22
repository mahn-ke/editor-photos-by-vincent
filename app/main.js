import { rmSync } from 'node:fs';
import path from 'node:path';
import { createBackground, loadMasterKey } from './src/background.js';
import { loadConfig } from './src/config.js';
import { createEditor } from './src/edits.js';
import { createImmichClient } from './src/immich.js';
import { createRenderPool } from './src/render.js';
import { createLearner } from './src/learn.js';
import { createGrader } from './src/ml/grader.js';
import { createMasker } from './src/ml/masks.js';
import { createMaskStore } from './src/mask-store.js';
import { createAnnouncer, createNotifier } from './src/notify.js';
import { createRawService } from './src/raw-service.js';
import { createApp } from './src/server.js';
import { armPriors, createSuggester } from './src/suggest.js';
import { openStore } from './src/sessions.js';

const config = loadConfig();

// Caches used to live in the (backed-up) data volume; drop those copies once they moved
if (path.resolve(config.cacheDir) !== path.resolve(config.dataDir)) {
    for (const dir of ['models', 'masks', 'raw']) rmSync(path.join(config.dataDir, dir), { recursive: true, force: true });
}
const store = openStore(path.join(config.dataDir, 'sessions.sqlite'));
const immich = createImmichClient({ baseUrl: config.immichUrl });
const renderPool = createRenderPool();
const learner = createLearner({ db: store.db, priors: armPriors() });
const grader = createGrader({ modelDir: config.modelDir });
const rawService = createRawService({ immich, dataDir: config.cacheDir });
// RAW-first edits are opt-in (RAW_EDITS=1); RAWs already kept as originals always preview correctly
const rawEdits = config.rawEdits ? rawService : null;
const suggester = createSuggester({ db: store.db, immich, grader, learner, dataDir: config.dataDir, rawService: rawEdits });
const maskStore = createMaskStore({ masker: createMasker({ modelDir: config.modelDir }), immich, dataDir: config.cacheDir, previewOf: (auth, id) => rawService.preview(auth, id) });
const editor = createEditor({
    immich,
    renderPool,
    maskStore,
    rawService: rawEdits,
    onEvent: (event) => {
        if (!event.userId) return;
        if (event.type === 'manual-edit') suggester.manualEdit(event.userId, event.originalId, event.recipe);
        if (event.type === 'version-discarded') suggester.discardedVersion(event.userId, event.originalId, event);
    },
});
const announce = createAnnouncer({
    suggester,
    notifier: createNotifier({ url: config.gotifyUrl, token: config.gotifyToken }),
    baseUrl: config.baseUrl,
});
const background = createBackground({
    db: store.db, immich, config,
    masterKey: loadMasterKey({ secret: config.appSecret, dataDir: config.dataDir }),
    handlers: {
        newAsset: async (userId, auth, asset) => {
            if (asset.type === 'IMAGE') background.enqueue(userId, 'suggest', asset.id);
        },
        // After a batch of uploads settles, work out the subjects of new suggestions; until then
        // they are not shown, so "Apply" can show the whole subject at once
        suggest: async (userId, auth, assetId) => {
            const outcome = await suggester.process(userId, auth, assetId);
            if (outcome !== 'done-before') background.enqueue(userId, 'subjects', '', 60000);
            return outcome;
        },
        // …and once the whole batch is through, announce the new suggestions (push notification)
        subjects: async (userId, auth) => {
            await suggester.prepareSubjects(userId, auth);
            await announce(userId, background.status(userId).pending);
            return 'ok';
        },
        // Fill the greeting with the last 4 weeks of uploads (up to 60 photos)
        'suggest-backfill': async (userId, auth) => {
            const since = new Date(Date.now() - 28 * 24 * 3600e3).toISOString();
            const { items } = await immich.searchMetadata(auth, { createdAfter: since, type: 'IMAGE', size: 60, page: 1 });
            for (const a of items) if (a.ownerId === undefined || a.ownerId === userId) background.enqueue(userId, 'suggest', a.id);
            return 'ok';
        },
        afterPoll: async (userId) => {
            suggester.expire();
            background.enqueue(userId, 'subjects', '', 1000);
        },
    },
});
const app = createApp({ config, store, immich, editor, background, suggester, maskStore, rawService });
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
