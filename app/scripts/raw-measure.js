// Measures the RAW→JPEG baseline on local Pixel pairs (PXL_….RAW-01.jpg + PXL_….RAW-02.ORIGINAL.dng):
// node scripts/raw-measure.js <dir> [name filter]   (VERBOSE=1 for fit details)
import { readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const APP = new URL('../src', import.meta.url).pathname;
const raw = await import(`${APP}/raw.js`);
const dir = process.argv[2];
const filter = process.argv[3] ?? '';
const log = { info: (m) => { if (process.env.VERBOSE) console.log('   ', m); }, warn: console.warn };
const results = [];
for (const dng of readdirSync(dir).filter(f => f.endsWith('.dng') && f.includes(filter))) {
    const base = dng.split('.RAW-02')[0];
    const jpg = `${base}.RAW-01.jpg`;
    const t0 = Date.now();
    const file = path.join(dir, dng);
    const prepared = raw.prepareSource ? await raw.prepareSource(file) : await (async () => {
        const [tags, dev] = await Promise.all([raw.readTags(file), raw.develop(file)]);
        return raw.applyGainMaps(dev, raw.parseGainMaps(tags.OpcodeList2));
    })();
    const { data, info } = await sharp(path.join(dir, jpg)).autoOrient().removeAlpha().resize({ width: 1440, height: 1440, fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
    const b = await raw.buildBaseline(prepared, data, info.width, info.height, log);
    if (process.env.DUMP) {
        // Side by side: developed RAW (auto-scaled, sRGB) | RAW with baseline | camera JPEG
        const W = 480;
        const small = (img) => {
            const h = Math.round(img.height * W / img.width);
            const out = new Float32Array(W * h * 3);
            for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) {
                const sx = Math.floor(x * img.width / W), sy = Math.floor(y * img.height / h);
                for (let c = 0; c < 3; c++) out[(y * W + x) * 3 + c] = img.data[(sy * img.width + sx) * 3 + c];
            }
            return { width: W, height: h, data: out };
        };
        const crop = raw.cropForBaseline ? raw.cropForBaseline(prepared, b.alignment) : prepared;
        const dev = small(crop);
        const sorted = Float32Array.from(dev.data).sort();
        const k = 0.9 / sorted[Math.floor(sorted.length * 0.98)];
        const enc = v => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)));
        const based = raw.applyBaseline(dev, b);
        const jpegSmall = await sharp(path.join(dir, jpg)).autoOrient().resize({ width: W, height: dev.height, fit: 'fill' }).removeAlpha().raw().toBuffer();
        const canvas = Buffer.alloc(W * 3 * dev.height * 3);
        for (let y = 0; y < dev.height; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
            const i = (y * W + x) * 3 + c, row = y * W * 3 * 3;
            canvas[row + x * 3 + c] = enc(dev.data[i] * k);
            canvas[row + (W + x) * 3 + c] = Math.round(255 * Math.min(1, based.data[i]));
            canvas[row + (2 * W + x) * 3 + c] = jpegSmall[i];
        }
        await sharp(canvas, { raw: { width: W * 3, height: dev.height, channels: 3 } }).jpeg({ quality: 85 }).toFile(path.join(process.env.DUMP, `${base}.png.jpg`));
    }
    results.push(b.quality.median);
    if (process.env.FULL) {
        // Full resolution, central 1024²: detail per scale and noise vs the camera JPEG, before
        // and after the fitted sharpening
        const crop = raw.cropForBaseline(prepared, b.alignment);
        const jm = await sharp(path.join(dir, jpg)).metadata();
        const portrait = crop.height > crop.width;
        const jw = portrait ? Math.min(jm.width, jm.height) : Math.max(jm.width, jm.height);
        const f = crop.width / jw, S = 1024;
        const region = (img, scale) => {
            const out = new Float32Array(S * S * 3);
            const ox = img.width / 2 - (S / 2) * scale, oy = img.height / 2 - (S / 2) * scale;
            for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
                const sx = Math.min(img.width - 1, Math.round(ox + x * scale)), sy = Math.min(img.height - 1, Math.round(oy + y * scale));
                for (let c = 0; c < 3; c++) out[(y * S + x) * 3 + c] = img.data[(sy * img.width + sx) * 3 + c];
            }
            return { width: S, height: S, data: out };
        };
        const ours = raw.applyBaseline(region(crop, f), b);
        const { data: jd, info: ji } = await sharp(path.join(dir, jpg)).autoOrient().removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const cam = region({ width: ji.width, height: ji.height, data: Float32Array.from(jd, v => v / 255) }, 1);
        const before = raw.fitSharpen(ours, cam, { coring: Number(process.env.CORING ?? 2) });
        raw.sharpen(ours, before.gains, before.cores);
        const after = raw.fitSharpen(ours, cam);
        console.log(`   cores ${before.cores.join("/")} full-res detail ours/jpeg ${before.detail.join('/')} noise ${before.noise} → gains ${before.gains.join('/')} → detail ${after.detail.join('/')} noise ${after.noise}`);
    }
    console.log(`${base.slice(4).padEnd(28)} dev ${prepared.width}x${prepared.height} jpeg ${info.width}x${info.height}  median ${String(b.quality.median).padStart(6)}  p95 ${String(b.quality.p95).padStart(6)}  align ${b.alignment.confidence}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
results.sort((a, b) => a - b);
console.log(`median of medians ${results[Math.floor(results.length / 2)]}, pass ≤6: ${results.filter(v => v <= 6).length}/${results.length}`);
