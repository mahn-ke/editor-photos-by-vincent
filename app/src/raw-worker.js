// RAW development, baseline fitting and full-resolution rendering, off the main thread
// (each takes seconds and ~1 GB at 12 MP)
import { writeFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { resize } from '../public/edit/pipeline.js';
import { applyBaseline, buildBaseline, cropForBaseline, fitDetail, prepareSource, sharpen } from './raw.js';

const PREVIEW_PIXELS = 1.6e6;
const log = { info: message => parentPort.postMessage({ log: message }), warn: message => parentPort.postMessage({ log: message }) };

// Bilinear resample of a float RGB image (the RAW crop is within 15% of the JPEG's size)
function resample(img, w, h) {
    const out = new Float32Array(w * h * 3);
    const sx = img.width / w, sy = img.height / h;
    for (let y = 0; y < h; y++) {
        const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
        const y0 = Math.floor(fy), y1 = Math.min(img.height - 1, y0 + 1), ay = fy - y0;
        for (let x = 0; x < w; x++) {
            const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
            const x0 = Math.floor(fx), x1 = Math.min(img.width - 1, x0 + 1), ax = fx - x0;
            for (let c = 0; c < 3; c++) {
                const a = img.data[(y0 * img.width + x0) * 3 + c], b = img.data[(y0 * img.width + x1) * 3 + c];
                const d = img.data[(y1 * img.width + x0) * 3 + c], e = img.data[(y1 * img.width + x1) * 3 + c];
                out[(y * w + x) * 3 + c] = (a + (b - a) * ax) * (1 - ay) + (d + (e - d) * ax) * ay;
            }
        }
    }
    return { width: w, height: h, data: out };
}

// Same pixels, centred in a frame of w×h (cropped, or edge pixels repeated)
function fitEdges(img, w, h) {
    const out = new Float32Array(w * h * 3);
    const ox = Math.round((img.width - w) / 2), oy = Math.round((img.height - h) / 2);
    for (let y = 0; y < h; y++) {
        const sy = Math.min(img.height - 1, Math.max(0, y + oy));
        for (let x = 0; x < w; x++) {
            const sx = Math.min(img.width - 1, Math.max(0, x + ox));
            const s = (sy * img.width + sx) * 3, d = (y * w + x) * 3;
            out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2];
        }
    }
    return { width: w, height: h, data: out };
}

const ops = {
    // Fits the baseline against the camera JPEG's preview pixels; writes the aligned linear
    // preview (Float32) for the editor's RAW endpoint
    async fit({ dng, jpeg, jpegFile, previewFile }) {
        const dev = await prepareSource(dng);
        const baseline = await buildBaseline(dev, new Uint8Array(jpeg.data), jpeg.width, jpeg.height, log);
        const crop = cropForBaseline(dev, baseline.alignment);
        // The camera's detail: sharpening fitted at full resolution (kept with the baseline,
        // so it still applies once the JPEG is gone)
        if (jpegFile) {
            const { gains, cores, detail, noise } = await fitDetail(crop, baseline, jpegFile);
            baseline.sharpen = { gains, cores };
            log.info(`RAW detail: ours/camera ${detail.join('/')}, noise ${noise}, sharpening ${gains.join('/')}`);
        }
        const scale = Math.min(1, Math.sqrt(PREVIEW_PIXELS / (crop.width * crop.height)));
        const small = resize(crop, Math.round(crop.width * scale), Math.round(crop.height * scale));
        writeFileSync(previewFile, Buffer.from(small.data.buffer));
        return { result: { baseline, width: small.width, height: small.height, cropWidth: crop.width, cropHeight: crop.height } };
    },
    // 16-bit sRGB pixels: the RAW with the camera look, cropped to the JPEG's framing and size
    async render({ dng, baseline, size }) {
        let dev = await prepareSource(dng);
        const crop = cropForBaseline(dev, baseline.alignment);
        // The crop is a copy unless the frames match: only then keep the developed image intact
        let look = applyBaseline(crop, baseline, { inPlace: crop !== dev });
        dev = null;
        if (size && (size.width !== look.width || size.height !== look.height)) {
            // Within 1 %: crop or extend the edges instead of interpolating every pixel
            const close = Math.abs(size.width / look.width - 1) < 0.01 && Math.abs(size.height / look.height - 1) < 0.01;
            look = close ? fitEdges(look, size.width, size.height) : resample(look, size.width, size.height);
        }
        if (baseline.sharpen) sharpen(look, baseline.sharpen.gains, baseline.sharpen.cores);
        const px = new Uint16Array(look.data.length);
        for (let i = 0; i < px.length; i++) px[i] = Math.round(Math.min(1, Math.max(0, look.data[i])) * 65535);
        return { result: { width: look.width, height: look.height, depth: 16, buffer: px.buffer }, transfer: [px.buffer] };
    },
};

parentPort.on('message', async ({ id, op, args }) => {
    try {
        const { result, transfer = [] } = await ops[op](args);
        parentPort.postMessage({ id, ok: true, result }, transfer);
    } catch (error) {
        parentPort.postMessage({ id, ok: false, error: error.message });
    }
});
