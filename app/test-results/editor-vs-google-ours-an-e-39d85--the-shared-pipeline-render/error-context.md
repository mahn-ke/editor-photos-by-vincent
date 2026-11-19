# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: editor-vs-google.spec.js >> ours: an edit saved through the UI equals the shared pipeline render
- Location: e2e/editor-vs-google.spec.js:72:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/edit/undefined?tab=adjust", waiting until "load"

```

# Test source

```ts
  1   | // End-to-end: the same edits in our editor (saved through Immich) and in Google Photos,
  2   | // on generated test images. Attaches to the Chrome started by `npm run e2e:browser`,
  3   | // where you signed in to Google Photos and SSO yourself.
  4   | //
  5   | // 1. ours:   UI edit → save → Immich version must equal a local render of the same recipe
  6   | // 2. google: same slider settings in Google Photos → download → compared with our render;
  7   | //            numbers go to e2e/report/google-vs-ours.json (also used to calibrate CAL)
  8   | // Test photos are moved to the trash afterwards in both services.
  9   | 
  10  | import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
  11  | import path from 'node:path';
  12  | import { chromium, expect, test } from '@playwright/test';
  13  | import sharp from 'sharp';
  14  | import { render, fromRGB, toRGB8 } from '../public/edit/pipeline.js';
  15  | import { CDP_PORT } from './chrome.js';
  16  | import { compareImages } from './compare.js';
  17  | import { cityscape, chart, writeJpeg } from './make-test-images.js';
  18  | 
  19  | const TMP = path.join(import.meta.dirname, '.tmp');
  20  | const REPORT = path.join(import.meta.dirname, 'report');
  21  | const IMMICH = 'https://photos.by.vincent.mahn.ke';
  22  | 
  23  | // Google's Adjust sliders, in panel order, and the values we try
  24  | const SLIDERS = ['hdr', 'brightness', 'contrast', 'whitePoint', 'highlights', 'shadows', 'blackPoint', 'saturation', 'warmth', 'tint', 'skinTone', 'blueTone', 'pop', 'vignette'];
  25  | const OPERATIONS = [
  26  |     ...['brightness', 'contrast', 'highlights', 'shadows', 'saturation', 'warmth', 'tint', 'blueTone'].flatMap(k => [-1, 0.5].map(v => ({ key: k, value: v }))),
  27  |     ...['hdr', 'pop', 'vignette'].map(k => ({ key: k, value: 0.6 })),
  28  |     { key: 'whitePoint', value: 0.5 }, { key: 'blackPoint', value: 0.5 },
  29  | ];
  30  | 
  31  | let browser;
  32  | let context;
  33  | let images;
  34  | 
  35  | test.beforeAll(async () => {
  36  |     browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  37  |     context = browser.contexts()[0];
  38  |     mkdirSync(TMP, { recursive: true });
  39  |     mkdirSync(REPORT, { recursive: true });
  40  |     images = {
  41  |         chart: await writeJpeg(chart(), path.join(TMP, 'editor-photos-e2e-chart.jpg')),
  42  |         city: await writeJpeg(cityscape(), path.join(TMP, 'editor-photos-e2e-city.jpg')),
  43  |     };
  44  | });
  45  | 
  46  | test.afterAll(async () => {
  47  |     await browser?.close(); // detaches only; your Chrome keeps running
  48  | });
  49  | 
  50  | async function localRender(file, recipe) {
  51  |     const { data, info } = await sharp(readFileSync(file)).raw().toBuffer({ resolveWithObject: true });
  52  |     const out = render(fromRGB(data, info.width, info.height), recipe);
  53  |     return sharp(Buffer.from(toRGB8(out).buffer), { raw: { width: out.width, height: out.height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  54  | }
  55  | 
  56  | async function immichUpload(page, file) {
  57  |     await page.goto(`${IMMICH}/photos`);
  58  |     const bytes = readFileSync(file).toString('base64');
  59  |     return page.evaluate(async ({ name, bytes }) => {
  60  |         const blob = new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], { type: 'image/jpeg' });
  61  |         const form = new FormData();
  62  |         const now = new Date().toISOString();
  63  |         form.append('filename', name);
  64  |         form.append('fileCreatedAt', now);
  65  |         form.append('fileModifiedAt', now);
  66  |         form.append('assetData', blob, name);
  67  |         const r = await fetch('/api/assets', { method: 'POST', body: form });
  68  |         return (await r.json()).id;
  69  |     }, { name: path.basename(file), bytes });
  70  | }
  71  | 
  72  | test('ours: an edit saved through the UI equals the shared pipeline render', async () => {
  73  |     const page = await context.newPage();
  74  |     const id = await immichUpload(page, images.city);
  75  |     await page.waitForTimeout(4000); // Immich generates the preview
> 76  |     await page.goto(`/edit/${id}?tab=adjust`);
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  77  |     await page.locator('input[aria-label="Contrast"]').fill('0.35');
  78  |     await page.locator('input[aria-label="Saturation"]').fill('0.4');
  79  |     await page.locator('#tab-crop').click();
  80  |     await page.locator('#ed-ruler').focus();
  81  |     await page.keyboard.press('ArrowRight');
  82  |     await page.keyboard.press('ArrowRight');
  83  |     for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
  84  |     await expect(page.locator('#ed-angle')).toHaveText('2.5°');
  85  |     await page.locator('#ed-save').click();
  86  |     await page.waitForURL(url => new URL(url).pathname === '/', { timeout: 120000 });
  87  |     const context1 = await page.evaluate(async id => (await fetch(`/api/edit/${id}`)).json(), id);
  88  |     const edit = context1.edits.at(-1);
  89  |     expect(edit.summary).toContain('Straighten +2.5°');
  90  |     await page.goto(`${IMMICH}/photos`);
  91  |     const saved = Buffer.from(await page.evaluate(async rid => {
  92  |         const r = await fetch(`/api/assets/${rid}/original`);
  93  |         return btoa(String.fromCharCode(...new Uint8Array(await r.arrayBuffer())));
  94  |     }, edit.renderedAssetId), 'base64');
  95  |     const local = await localRender(images.city, { geometry: { angle: 2.5 }, adjust: { contrast: 0.35, saturation: 0.4 } });
  96  |     const result = await compareImages(saved, local);
  97  |     writeFileSync(path.join(REPORT, 'ours.json'), JSON.stringify(result, null, 2));
  98  |     expect(result.medianDeltaE).toBeLessThan(1);
  99  |     expect(result.ssim).toBeGreaterThan(0.98);
  100 |     // Clean up: discard the version (to trash) and trash the upload
  101 |     await page.goto('/');
  102 |     await page.evaluate(async id => fetch(`/api/edit/${id}/discard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) }), id);
  103 |     await page.goto(`${IMMICH}/photos`);
  104 |     await page.evaluate(async id => fetch('/api/assets', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) }), id);
  105 |     await page.close();
  106 | });
  107 | 
  108 | test('google: the same slider edits in Google Photos, compared with ours', async () => {
  109 |     test.skip(process.env.E2E_GOOGLE === '0', 'Google comparison disabled');
  110 |     const page = await context.newPage();
  111 |     await page.goto('https://photos.google.com/');
  112 |     // Upload the chart through Google's own file input
  113 |     await page.locator('input[type=file]').first().setInputFiles(images.chart);
  114 |     await page.waitForTimeout(15000);
  115 |     await page.goto('https://photos.google.com/');
  116 |     const first = page.locator('a[href*="/photo/"]').first();
  117 |     const href = await first.getAttribute('href');
  118 |     const photoUrl = new URL(href, 'https://photos.google.com/').href;
  119 |     const results = [];
  120 |     for (const op of OPERATIONS) {
  121 |         await page.goto(`${photoUrl}/edit`);
  122 |         await page.getByRole('tab', { name: 'Adjust' }).click();
  123 |         const slider = page.locator('[role=tabpanel] input[type=range]').nth(SLIDERS.indexOf(op.key));
  124 |         await slider.fill(String(op.value));
  125 |         await page.getByRole('button', { name: 'Save' }).click();
  126 |         await page.waitForTimeout(4000);
  127 |         const downloadPromise = page.waitForEvent('download');
  128 |         await page.keyboard.press('Shift+D');
  129 |         const download = await downloadPromise;
  130 |         const google = readFileSync(await download.path());
  131 |         const ours = await localRender(images.chart, { adjust: { [op.key]: op.value } });
  132 |         const metrics = await compareImages(google, ours);
  133 |         results.push({ ...op, ...metrics });
  134 |         // Back to the original for the next operation
  135 |         await page.goto(`${photoUrl}/edit`);
  136 |         await page.getByRole('button', { name: 'Revert' }).click().catch(() => {});
  137 |         await page.getByRole('button', { name: 'Save' }).click().catch(() => {});
  138 |         await page.waitForTimeout(2000);
  139 |     }
  140 |     writeFileSync(path.join(REPORT, 'google-vs-ours.json'), JSON.stringify(results, null, 2));
  141 |     for (const r of results) {
  142 |         expect.soft(r.medianDeltaE, `${r.key} ${r.value}`).toBeLessThanOrEqual(3);
  143 |         expect.soft(r.ssim, `${r.key} ${r.value}`).toBeGreaterThanOrEqual(0.95);
  144 |     }
  145 |     // Move the test photo to Google Photos' trash
  146 |     await page.goto(photoUrl);
  147 |     await page.keyboard.press('#');
  148 |     await page.getByRole('button', { name: /Move to trash/i }).click().catch(() => {});
  149 |     await page.close();
  150 | });
  151 | 
```