import { Worker } from 'node:worker_threads';
import sharp from 'sharp';

sharp.cache(false);

// Upright, 16-bit sRGB pixels from any format sharp can read (JPEG, PNG, WebP, AVIF, TIFF)
export async function decode(bytes) {
    const { data, info } = await sharp(bytes, { failOn: 'none', limitInputPixels: 268402689 })
        .autoOrient()
        .removeAlpha()
        .toColourspace('rgb16')
        .raw({ depth: 'ushort' })
        .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, depth: 16, buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}

const pad = n => String(n).padStart(2, '0');

// EXIF date strings in the photo's own local time, with its UTC offset
export function exifDates(fileCreatedAt, localDateTime) {
    const instant = new Date(fileCreatedAt);
    const local = new Date(localDateTime ?? fileCreatedAt);
    if (Number.isNaN(instant.getTime())) return null;
    const offsetMinutes = Number.isNaN(local.getTime()) ? 0 : Math.round((local - instant) / 60000);
    const sign = offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(offsetMinutes);
    const wall = Number.isNaN(local.getTime()) ? instant : local;
    return {
        exif: `${wall.getUTCFullYear()}:${pad(wall.getUTCMonth() + 1)}:${pad(wall.getUTCDate())} ${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`,
        offset: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
        iso: `${wall.toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
    };
}

export async function encodeJpeg({ width, height, buffer }, { make, model, dates, quality = 92 } = {}) {
    const exif = { IFD0: { Software: 'editor.photos.by.vincent.mahn.ke' }, IFD2: {} };
    if (make) exif.IFD0.Make = String(make);
    if (model) exif.IFD0.Model = String(model);
    if (dates) {
        exif.IFD0.DateTime = dates.exif;
        exif.IFD2.DateTimeOriginal = dates.exif;
        exif.IFD2.OffsetTimeOriginal = dates.offset;
    }
    return sharp(Buffer.from(buffer), { raw: { width, height, channels: 3 } })
        .withIccProfile('srgb')
        .withExif(exif)
        .jpeg({ quality, chromaSubsampling: '4:4:4' })
        .toBuffer();
}

// One worker, one job at a time: full-resolution renders need several hundred MB
export function createRenderPool({ workerUrl = new URL('./render-worker.js', import.meta.url) } = {}) {
    let worker = null;
    let nextId = 1;
    const pending = new Map();
    let chain = Promise.resolve();

    const ensure = () => {
        if (worker) return worker;
        worker = new Worker(workerUrl);
        worker.on('message', ({ id, ok, error, ...result }) => {
            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            if (!pending.size) worker?.unref();
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
    };

    const run = (decoded, recipe, maxPixels, masks) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const w = ensure();
        w.ref();
        w.postMessage({ id, ...decoded, recipe, maxPixels, masks }, [decoded.buffer]);
    });

    return {
        render(decoded, recipe, { maxPixels, masks = null } = {}) {
            const job = chain.then(() => run(decoded, recipe, maxPixels, masks));
            chain = job.catch(() => {});
            return job;
        },
        async close() {
            await worker?.terminate();
            worker = null;
        },
    };
}
