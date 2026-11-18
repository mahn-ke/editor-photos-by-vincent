// RAW sources for the editor: finds the DNG paired with a JPEG, develops it, fits and
// caches the baseline, and serves a linear preview for the browser.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { pairKey, matchPair } from './raw-pairs.js';
import { MAX_DELTA_E, applyBaseline, applyGainMaps, buildBaseline, develop, parseGainMaps, readTags } from './raw.js';
import { resize } from '../public/edit/pipeline.js';

const PREVIEW_PIXELS = 1.6e6;

export function createRawService({ immich, dataDir, log = console }) {
    const dir = path.join(dataDir === ':memory:' ? path.join(process.cwd(), 'data') : dataDir, 'raw');
    mkdirSync(dir, { recursive: true });
    const inflight = new Map();
    const file = (id, ext) => path.join(dir, `${id}.${ext}`);

    async function partner(auth, jpegId) {
        const jpeg = await immich.asset(auth, jpegId);
        const key = pairKey(jpeg.originalFileName);
        if (!key || key.part !== 'jpeg') return null;
        // Prefer the stack (the background job pairs them), else search by name
        let candidates = [];
        if (jpeg.stack?.id) candidates = (await immich.stack(auth, jpeg.stack.id)).assets ?? [];
        if (!candidates.some(a => /\.dng$/i.test(a.originalFileName ?? ''))) {
            const { items } = await immich.searchMetadata(auth, { originalFileName: key.base, size: 20, withExif: true });
            candidates = items;
        }
        const match = matchPair([jpeg, ...candidates.filter(a => a.id !== jpeg.id)], key);
        return match ? { jpeg, raw: match.raw } : null;
    }

    async function developed(auth, rawId) {
        const dng = file(rawId, 'dng');
        if (!existsSync(dng)) {
            const response = await immich.original(auth, rawId);
            writeFileSync(dng, Buffer.from(await response.arrayBuffer()));
        }
        const [tags, dev] = await Promise.all([readTags(dng), develop(dng)]);
        return applyGainMaps(dev, parseGainMaps(tags.OpcodeList2));
    }

    async function jpegPreview(auth, jpegId) {
        const response = await immich.media(auth, jpegId, 'preview');
        const bytes = Buffer.from(await response.arrayBuffer());
        const { data, info } = await sharp(bytes).autoOrient().removeAlpha().raw().toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
    }

    async function build(auth, jpegId) {
        const pair = await partner(auth, jpegId);
        if (!pair) return { available: false, reason: 'no-raw' };
        const dev = await developed(auth, pair.raw.id);
        const jpeg = await jpegPreview(auth, jpegId);
        const baseline = await buildBaseline(dev, jpeg.data, jpeg.width, jpeg.height, log);
        const ok = baseline.quality.median <= MAX_DELTA_E && baseline.alignment.confidence >= 0.2;
        // Preview: aligned linear RAW at preview size, stored as Float32 (≈19 MB at 1.6 MP)
        const a = baseline.alignment;
        const crop = cropDev(dev, a);
        const scale = Math.min(1, Math.sqrt(PREVIEW_PIXELS / (crop.width * crop.height)));
        const small = resize(crop, Math.round(crop.width * scale), Math.round(crop.height * scale));
        writeFileSync(file(jpegId, 'preview.f32'), Buffer.from(small.data.buffer));
        const info = { available: ok, reason: ok ? null : 'poor-match', rawAssetId: pair.raw.id, quality: baseline.quality, alignment: a, width: small.width, height: small.height, baseline };
        writeFileSync(file(jpegId, 'json'), JSON.stringify(info));
        return info;
    }

    async function info(auth, jpegId) {
        const cached = file(jpegId, 'json');
        if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
        if (!inflight.has(jpegId)) inflight.set(jpegId, build(auth, jpegId).finally(() => inflight.delete(jpegId)));
        return inflight.get(jpegId);
    }

    function previewBinary(jpegId) {
        const f = file(jpegId, 'preview.f32');
        return existsSync(f) ? readFileSync(f) : null;
    }

    // Full-resolution linear source for saving, cropped to the JPEG's framing
    async function fullSource(auth, jpegId) {
        const meta = await info(auth, jpegId);
        if (!meta.available) return null;
        const dev = await developed(auth, meta.rawAssetId);
        return { image: cropDev(dev, meta.alignment), baseline: meta.baseline };
    }

    function forget(jpegId, rawId) {
        for (const f of [file(jpegId, 'json'), file(jpegId, 'preview.f32'), rawId && file(rawId, 'dng')]) if (f) rmSync(f, { force: true });
    }

    return { info, previewBinary, fullSource, forget };
}

// Crops the developed image to the region that matches the JPEG frame
function cropDev(dev, a) {
    const x0 = Math.max(0, Math.round(a.dx * dev.width));
    const y0 = Math.max(0, Math.round(a.dy * dev.height));
    const w = Math.min(dev.width - x0, Math.round(dev.width / a.scale / (dev.width / dev.width)));
    const h = Math.min(dev.height - y0, Math.round(dev.height / a.scale));
    if (x0 === 0 && y0 === 0 && w === dev.width && h === dev.height) return dev;
    const out = { width: w, height: h, data: new Float32Array(w * h * 3) };
    for (let y = 0; y < h; y++) out.data.set(dev.data.subarray(((y0 + y) * dev.width + x0) * 3, ((y0 + y) * dev.width + x0 + w) * 3), y * w * 3);
    return out;
}

export { applyBaseline };
