// Runs the app against the fake Immich for local UI work: `npm run dev:fake`
import { createImmichClient } from '../src/immich.js';
import { createApp } from '../src/server.js';
import { openStore } from '../src/sessions.js';
import { generateLibrary, startFakeImmich } from './fake-immich.js';

const port = Number(process.env.PORT || 3000);
const fake = await startFakeImmich({ library: generateLibrary({ months: 18 }) });
const config = { port, baseUrl: `http://localhost:${port}`, immichUrl: fake.url, dataDir: ':memory:' };
const app = createApp({ config, store: openStore(':memory:'), immich: createImmichClient({ baseUrl: fake.url }) });

app.listen(port, () => {
    console.log(`Fake Immich at ${fake.url}`);
    console.log(`Open ${config.baseUrl}`);
});
