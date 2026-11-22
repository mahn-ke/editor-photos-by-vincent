// Runs the app against the fake Immich for local UI work: `npm run dev:fake`
import { createEditor } from '../src/edits.js';
import { createImmichClient } from '../src/immich.js';
import { createRenderPool } from '../src/render.js';
import { createApp } from '../src/server.js';
import { openStore } from '../src/sessions.js';
import sharp from 'sharp';
import { generateLibrary, startFakeImmich } from './fake-immich.js';

const port = Number(process.env.PORT || 3000);
const library = generateLibrary({ months: 18 });
const fake = await startFakeImmich({ library });
const config = { port, baseUrl: `http://localhost:${port}`, immichUrl: fake.url, dataDir: ':memory:' };
const immich = createImmichClient({ baseUrl: fake.url });
const editor = createEditor({ immich, renderPool: createRenderPool() });
const app = createApp({ config, store: openStore(':memory:'), immich, editor, suggester: await fakeSuggester(library) });

// A few generated before/after pairs so the greeting and its full-screen preview can be tried
async function fakeSuggester(library) {
    const photos = library[0].assets.filter(a => a.isImage).slice(0, 3);
    const looks = [
        { name: 'Vivid look', why: 'you used Vivid on 12 similar photos', hue: 210, recipe: { adjust: { saturation: 0.4, pop: 0.3 } } },
        { name: 'Neon night', why: 'night shot with strong lights', hue: 280, recipe: { filter: { id: 'neon', strength: 1 } } },
        { name: 'Straighten + Enhance', why: 'horizon tilted by 3.1°', hue: 30, recipe: { geometry: { angle: -3.1 }, adjust: { shadows: 0.25 } } },
    ];
    const rows = new Map();
    for (const [i, photo] of photos.entries()) {
        const look = looks[i];
        const svg = (sat, light) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
            <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="hsl(${look.hue} ${sat}% ${light + 15}%)"/><stop offset="1" stop-color="hsl(${look.hue + 40} ${sat}% ${light - 20}%)"/></linearGradient></defs>
            <rect width="1200" height="900" fill="url(#g)"/>
            <circle cx="${300 + i * 250}" cy="420" r="160" fill="hsl(${look.hue + 180} ${sat}% ${light}%)"/>
            <rect x="0" y="640" width="1200" height="260" fill="hsl(${look.hue + 90} ${sat * 0.7}% ${light - 25}%)"/></svg>`);
        rows.set(`s${i + 1}`, {
            id: `s${i + 1}`, asset_id: photo.id, name: look.name, why: look.why, recipe: look.recipe, status: 'ready',
            before: await sharp(svg(25, 45)).jpeg().toBuffer(),
            after: await sharp(svg(80, 50)).jpeg().toBuffer(),
        });
    }
    const visible = () => [...rows.values()].filter(r => r.status === 'ready');
    const card = r => ({ id: r.id, assetId: r.asset_id, name: r.name, why: r.why, summary: r.name });
    return {
        greeting: () => ({ text: 'Based on your uploads in the last 3 days, here are some edits', suggestions: visible().map(card) }),
        forAsset: (userId, assetId) => visible().filter(r => r.asset_id === assetId).map(card),
        get: (userId, id) => rows.get(id) ?? null,
        preview: (userId, id, which) => rows.get(id)?.[which] ?? null,
        setStatus: (id, status) => { if (rows.has(id)) rows.get(id).status = status; },
        accepted: (userId, id) => { if (rows.has(id)) rows.get(id).status = 'applied'; },
        // Pretend the next few photos of the library show the same subject
        storedSubject: (userId, id) => rows.get(id)?.subject ?? [],
        subject: async (userId, token, id) => rows.has(id) ? (rows.get(id).subject = library[0].assets.filter(a => a.isImage).slice(3 + Number(id.slice(1)) * 3, 6 + Number(id.slice(1)) * 3).map(a => a.id)) : [],
        retire: () => {},
        dismiss: (userId, id) => (rows.has(id) ? (rows.get(id).status = 'dismissed') : false),
    };
}

app.listen(port, () => {
    console.log(`Fake Immich at ${fake.url}`);
    console.log(`Open ${config.baseUrl}`);
});
