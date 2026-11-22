// RAW sources: finds the DNG paired with a JPEG, develops it, fits and caches the baseline
// (the RAW → camera-JPEG look), and renders full-resolution sources for saving and previews
// for RAWs kept as the original (their baseline lives in Immich metadata, RAW_KEY).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { pairKey, matchPair } from './raw-pairs.js';
import { Worker } from 'node:worker_threads';
import { MAX_DELTA_E, applyBaseline } from './raw.js';

const INFO_VERSION = 3; // bump when development or fitting changes: cached matches are refitted
export const RAW_KEY = 'editor-photos-raw';
// The RAW is only used when its crop has (almost) the JPEG's resolution: zoom shots store a
// small crop that the camera upscales with multi-frame detail the RAW lacks
const MIN_RESOLUTION = 0.85;

export function createRawService({ immich, dataDir, log = console }) {
    const dir = path.join(dataDir === ':memory:' ? path.join(process.cwd(), 'data') : dataDir, 'raw');
    mkdirSync(dir, { recursive: true });
    const inflight = new Map();
    const file = (id, ext) => path.join(dir, `${id}.${ext}`);
    const infoFile = id => file(id, `v${INFO_VERSION}.json`);

    // One worker, one job at a time (each needs ~1 GB at 12 MP), ended when idle
    let worker = null;
    let chain = Promise.resolve();
    let nextId = 1;
    const pending = new Map();
    function ensureWorker() {
        if (worker) return worker;
        worker = new Worker(new URL('./raw-worker.js', import.meta.url));
        worker.on('message', ({ id, ok, result, error, log: line }) => {
            if (line) return log.info?.(line);
            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            // Ending the worker after each job hands its memory back at once (the container
            // has 3 GB, shared with the render worker and the ML models)
            if (!pending.size) {
                worker?.terminate();
                worker = null;
            }
            if (ok) entry.resolve(result);
            else entry.reject(new Error(error));
        });
        worker.on('error', (error) => {
            for (const entry of pending.values()) entry.reject(error);
            pending.clear();
            worker = null;
        });
        worker.unref();
        return worker;
    }
    function runInWorker(op, args, transfer = []) {
        const job = chain.then(() => new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            const w = ensureWorker();
            w.ref();
            w.postMessage({ id, op, args }, transfer);
        }));
        chain = job.catch(() => {});
        return job;
    }

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

    // Downloaded DNGs (~15 MB) and camera JPEGs are kept for a week; fits and previews stay
    function pruneDngs() {
        for (const name of readdirSync(dir)) {
            if (!name.endsWith('.dng') && !/^[\w-]+\.jpg$/.test(name)) continue;
            try {
                if (Date.now() - statSync(path.join(dir, name)).mtimeMs > 7 * 24 * 3600e3) rmSync(path.join(dir, name), { force: true });
            } catch {
                // removed meanwhile
            }
        }
    }

    // The DNG in the cache (downloaded once)
    async function dngFile(auth, rawId) {
        const dng = file(rawId, 'dng');
        if (!existsSync(dng)) {
            pruneDngs();
            const response = await immich.original(auth, rawId);
            writeFileSync(dng, Buffer.from(await response.arrayBuffer()));
        }
        return dng;
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
        const dng = await dngFile(auth, pair.raw.id);
        const jpeg = await jpegPreview(auth, jpegId);
        // The full-size camera JPEG, for fitting the sharpening to its detail
        const jpegFile = file(jpegId, 'jpg');
        if (!existsSync(jpegFile)) {
            const response = await immich.original(auth, jpegId);
            writeFileSync(jpegFile, Buffer.from(await response.arrayBuffer()));
        }
        const fitted = await runInWorker('fit', { dng, jpeg: { data: jpeg.data.buffer.slice(jpeg.data.byteOffset, jpeg.data.byteOffset + jpeg.data.byteLength), width: jpeg.width, height: jpeg.height }, jpegFile, previewFile: file(jpegId, 'preview.f32') });
        const { baseline } = fitted;
        const ok = baseline.quality.median <= MAX_DELTA_E && baseline.alignment.confidence >= 0.2;
        const a = baseline.alignment;
        const info = { available: ok, reason: ok ? null : 'poor-match', rawAssetId: pair.raw.id, quality: baseline.quality, alignment: a, width: fitted.width, height: fitted.height, cropWidth: fitted.cropWidth, cropHeight: fitted.cropHeight, baseline };
        writeFileSync(infoFile(jpegId), JSON.stringify(info));
        return info;
    }

    async function info(auth, jpegId) {
        const cached = infoFile(jpegId);
        if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
        if (!inflight.has(jpegId)) inflight.set(jpegId, build(auth, jpegId).finally(() => inflight.delete(jpegId)));
        return inflight.get(jpegId);
    }

    function previewBinary(jpegId) {
        const f = file(jpegId, 'preview.f32');
        return existsSync(f) ? readFileSync(f) : null;
    }

    // The RAW to render a JPEG's edit from, or null (no RAW, poor match, or a zoom crop)
    async function sourceFor(auth, jpeg) {
        const meta = await info(auth, jpeg.id);
        if (!meta.available) return null;
        const size = jpegSize(jpeg, meta);
        if (meta.cropWidth && Math.max(meta.cropWidth, meta.cropHeight) < MIN_RESOLUTION * Math.max(size.width, size.height)) return null;
        return { rawId: meta.rawAssetId, baseline: meta.baseline, size, quality: meta.quality };
    }

    // Full-resolution 16-bit sRGB pixels: developed RAW, cropped to the JPEG's framing, with
    // the baseline applied, at the JPEG's size (so masks and crops line up)
    async function render(auth, rawId, baseline, size) {
        return runInWorker('render', { dng: await dngFile(auth, rawId), baseline, size });
    }

    // A RAW kept as the original (RAW_KEY metadata): its look as a JPEG preview, cached, or null
    async function preview(auth, rawId) {
        const cached = file(rawId, `v${INFO_VERSION}.preview.jpg`);
        if (existsSync(cached)) return readFileSync(cached);
        const stored = (await immich.metadata(auth, rawId))[RAW_KEY];
        if (!stored?.baseline) return null;
        if (!inflight.has(cached)) {
            inflight.set(cached, (async () => {
                const { width, height, buffer } = await render(auth, rawId, stored.baseline, stored.size);
                const px = new Uint16Array(buffer);
                const bytes = await sharp(Buffer.from(Uint8Array.from(px, v => v >> 8)), { raw: { width, height, channels: 3 } })
                    .resize({ width: 2048, height: 2048, fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();
                writeFileSync(cached, bytes);
                return bytes;
            })().finally(() => inflight.delete(cached)));
        }
        return inflight.get(cached);
    }

    function forget(jpegId, rawId) {
        for (const f of [infoFile(jpegId), file(jpegId, 'preview.f32'), rawId && file(rawId, 'dng')]) if (f) rmSync(f, { force: true });
    }

    return { info, previewBinary, sourceFor, render, preview, forget };
}

export { applyBaseline };

// The JPEG's pixel size, upright (Immich's width/height may be the sensor's)
function jpegSize(jpeg, meta) {
    const w = Number(jpeg.exifInfo?.exifImageWidth ?? jpeg.width) || meta.cropWidth;
    const h = Number(jpeg.exifInfo?.exifImageHeight ?? jpeg.height) || meta.cropHeight;
    const portrait = meta.cropHeight > meta.cropWidth;
    return portrait ? { width: Math.min(w, h), height: Math.max(w, h) } : { width: Math.max(w, h), height: Math.min(w, h) };
}

