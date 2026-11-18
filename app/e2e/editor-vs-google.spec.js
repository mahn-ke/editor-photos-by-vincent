// End-to-end: the same edits in our editor (saved through Immich) and in Google Photos,
// on generated test images. Attaches to the Chrome started by `npm run e2e:browser`,
// where you signed in to Google Photos and SSO yourself.
//
// 1. ours:   UI edit → save → Immich version must equal a local render of the same recipe
// 2. google: same slider settings in Google Photos → download → compared with our render;
//            numbers go to e2e/report/google-vs-ours.json (also used to calibrate CAL)
// Test photos are moved to the trash afterwards in both services.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import sharp from 'sharp';
import { render, fromRGB, toRGB8 } from '../public/edit/pipeline.js';
import { CDP_PORT } from './chrome.js';
import { compareImages } from './compare.js';
import { cityscape, chart, writeJpeg } from './make-test-images.js';

const TMP = path.join(import.meta.dirname, '.tmp');
const REPORT = path.join(import.meta.dirname, 'report');
const IMMICH = 'https://photos.by.vincent.mahn.ke';

// Google's Adjust sliders, in panel order, and the values we try
const SLIDERS = ['hdr', 'brightness', 'contrast', 'whitePoint', 'highlights', 'shadows', 'blackPoint', 'saturation', 'warmth', 'tint', 'skinTone', 'blueTone', 'pop', 'vignette'];
const OPERATIONS = [
    ...['brightness', 'contrast', 'highlights', 'shadows', 'saturation', 'warmth', 'tint', 'blueTone'].flatMap(k => [-1, 0.5].map(v => ({ key: k, value: v }))),
    ...['hdr', 'pop', 'vignette'].map(k => ({ key: k, value: 0.6 })),
    { key: 'whitePoint', value: 0.5 }, { key: 'blackPoint', value: 0.5 },
];

let browser;
let context;
let images;

test.beforeAll(async () => {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    context = browser.contexts()[0];
    mkdirSync(TMP, { recursive: true });
    mkdirSync(REPORT, { recursive: true });
    images = {
        chart: await writeJpeg(chart(), path.join(TMP, 'editor-photos-e2e-chart.jpg')),
        city: await writeJpeg(cityscape(), path.join(TMP, 'editor-photos-e2e-city.jpg')),
    };
});

test.afterAll(async () => {
    await browser?.close(); // detaches only; your Chrome keeps running
});

async function localRender(file, recipe) {
    const { data, info } = await sharp(readFileSync(file)).raw().toBuffer({ resolveWithObject: true });
    const out = render(fromRGB(data, info.width, info.height), recipe);
    return sharp(Buffer.from(toRGB8(out).buffer), { raw: { width: out.width, height: out.height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

async function immichUpload(page, file) {
    await page.goto(`${IMMICH}/photos`);
    const bytes = readFileSync(file).toString('base64');
    return page.evaluate(async ({ name, bytes }) => {
        const blob = new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], { type: 'image/jpeg' });
        const form = new FormData();
        const now = new Date().toISOString();
        form.append('filename', name);
        form.append('fileCreatedAt', now);
        form.append('fileModifiedAt', now);
        form.append('assetData', blob, name);
        const r = await fetch('/api/assets', { method: 'POST', body: form });
        return (await r.json()).id;
    }, { name: path.basename(file), bytes });
}

test('ours: an edit saved through the UI equals the shared pipeline render', async () => {
    const page = await context.newPage();
    const id = await immichUpload(page, images.city);
    await page.waitForTimeout(4000); // Immich generates the preview
    await page.goto(`/edit/${id}?tab=adjust`);
    await page.locator('input[aria-label="Contrast"]').fill('0.35');
    await page.locator('input[aria-label="Saturation"]').fill('0.4');
    await page.locator('#tab-crop').click();
    await page.locator('#ed-ruler').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
    await expect(page.locator('#ed-angle')).toHaveText('2.5°');
    await page.locator('#ed-save').click();
    await page.waitForURL(url => new URL(url).pathname === '/', { timeout: 120000 });
    const context1 = await page.evaluate(async id => (await fetch(`/api/edit/${id}`)).json(), id);
    const edit = context1.edits.at(-1);
    expect(edit.summary).toContain('Straighten +2.5°');
    await page.goto(`${IMMICH}/photos`);
    const saved = Buffer.from(await page.evaluate(async rid => {
        const r = await fetch(`/api/assets/${rid}/original`);
        return btoa(String.fromCharCode(...new Uint8Array(await r.arrayBuffer())));
    }, edit.renderedAssetId), 'base64');
    const local = await localRender(images.city, { geometry: { angle: 2.5 }, adjust: { contrast: 0.35, saturation: 0.4 } });
    const result = await compareImages(saved, local);
    writeFileSync(path.join(REPORT, 'ours.json'), JSON.stringify(result, null, 2));
    expect(result.medianDeltaE).toBeLessThan(1);
    expect(result.ssim).toBeGreaterThan(0.98);
    // Clean up: discard the version (to trash) and trash the upload
    await page.goto('/');
    await page.evaluate(async id => fetch(`/api/edit/${id}/discard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) }), id);
    await page.goto(`${IMMICH}/photos`);
    await page.evaluate(async id => fetch('/api/assets', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) }), id);
    await page.close();
});

test('google: the same slider edits in Google Photos, compared with ours', async () => {
    test.skip(process.env.E2E_GOOGLE === '0', 'Google comparison disabled');
    const page = await context.newPage();
    await page.goto('https://photos.google.com/');
    // Upload the chart through Google's own file input
    await page.locator('input[type=file]').first().setInputFiles(images.chart);
    await page.waitForTimeout(15000);
    await page.goto('https://photos.google.com/');
    const first = page.locator('a[href*="/photo/"]').first();
    const href = await first.getAttribute('href');
    const photoUrl = new URL(href, 'https://photos.google.com/').href;
    const results = [];
    for (const op of OPERATIONS) {
        await page.goto(`${photoUrl}/edit`);
        await page.getByRole('tab', { name: 'Adjust' }).click();
        const slider = page.locator('[role=tabpanel] input[type=range]').nth(SLIDERS.indexOf(op.key));
        await slider.fill(String(op.value));
        await page.getByRole('button', { name: 'Save' }).click();
        await page.waitForTimeout(4000);
        const downloadPromise = page.waitForEvent('download');
        await page.keyboard.press('Shift+D');
        const download = await downloadPromise;
        const google = readFileSync(await download.path());
        const ours = await localRender(images.chart, { adjust: { [op.key]: op.value } });
        const metrics = await compareImages(google, ours);
        results.push({ ...op, ...metrics });
        // Back to the original for the next operation
        await page.goto(`${photoUrl}/edit`);
        await page.getByRole('button', { name: 'Revert' }).click().catch(() => {});
        await page.getByRole('button', { name: 'Save' }).click().catch(() => {});
        await page.waitForTimeout(2000);
    }
    writeFileSync(path.join(REPORT, 'google-vs-ours.json'), JSON.stringify(results, null, 2));
    for (const r of results) {
        expect.soft(r.medianDeltaE, `${r.key} ${r.value}`).toBeLessThanOrEqual(3);
        expect.soft(r.ssim, `${r.key} ${r.value}`).toBeGreaterThanOrEqual(0.95);
    }
    // Move the test photo to Google Photos' trash
    await page.goto(photoUrl);
    await page.keyboard.press('#');
    await page.getByRole('button', { name: /Move to trash/i }).click().catch(() => {});
    await page.close();
});
