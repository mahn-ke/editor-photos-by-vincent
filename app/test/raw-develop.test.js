import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_SHARPEN, cameraToSrgb, clipToWhite, denoise, fitSharpen, noiseCurve, sharpen, transferDetail } from '../src/raw.js';

// Deterministic pseudo-random numbers and Gaussian noise
function rng(seed = 1) {
    let s = seed;
    return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}
function gauss(r) {
    return Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
}

test('camera neutral maps to sRGB white (DNG ColorMatrix/ForwardMatrix)', () => {
    const tags = {
        ColorMatrix1: '1.1648 -0.6376 0.0243 -0.3076 1.1736 0.1491 0.0019 0.1399 0.6466',
        ColorMatrix2: '0.849 -0.2014 -0.1226 -0.585 1.4801 0.1018 -0.186 0.3981 0.4547',
        ForwardMatrix1: '0.552 0.3075 0.1048 0.1175 0.9251 -0.0425 -0.0803 -0.5379 1.4432',
        ForwardMatrix2: '0.6541 0.146 0.1642 0.2584 0.7849 -0.0433 0.0294 -0.4763 1.272',
        CalibrationIlluminant1: 17, CalibrationIlluminant2: 21, AsShotNeutral: '0.5 1 0.7',
    };
    const m = cameraToSrgb(tags);
    const white = m.map(row => row[0] * 0.5 + row[1] * 1 + row[2] * 0.7);
    for (const v of white) assert.ok(Math.abs(v - white[1]) < 0.02 * white[1], `neutral stays neutral: ${white}`);
});

test('noise-profile denoising removes noise and keeps edges and levels', () => {
    const w = 128, h = 64, r = rng(7);
    const S = 1e-4, O = 1e-6;
    const clean = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) clean[(y * w + x) * 3 + c] = x < w / 2 ? 0.05 : 0.4;
    const noisy = Float32Array.from(clean, v => Math.max(0, v + Math.sqrt(S * v + O) * gauss(r)));
    const img = { width: w, height: h, data: Float32Array.from(noisy) };
    denoise(img, [[S, O], [S, O], [S, O]]);
    const rms = (a) => Math.sqrt(a.reduce((s, v, i) => s + (v - clean[i]) ** 2, 0) / a.length);
    assert.ok(rms(img.data) < rms(noisy) * 0.5, `error ${rms(img.data)} vs noisy ${rms(noisy)}`);
    const at = (x, y) => img.data[(y * w + x) * 3 + 1];
    assert.ok(Math.abs(at(10, 30) - 0.05) < 0.01 && Math.abs(at(110, 30) - 0.4) < 0.02, 'levels kept');
    assert.ok(at(w / 2 + 2, 30) - at(w / 2 - 3, 30) > 0.3, 'edge kept');
});

// Soften: the image blended with its 3×3 box blur (`amount` of the blur)
function blur(img, amount) {
    const { width: size } = img;
    const out = { width: size, height: img.height, data: new Float32Array(img.data.length) };
    for (let y = 0; y < img.height; y++) for (let x = 0; x < size; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += img.data[((Math.min(img.height - 1, Math.max(0, y + dy))) * size + Math.min(size - 1, Math.max(0, x + dx))) * 3];
        const i = (y * size + x) * 3;
        out.data.fill(img.data[i] * (1 - amount) + (s / 9) * amount, i, i + 3);
    }
    return out;
}

test('sharpening is fitted so a softened image regains the reference detail', () => {
    const size = 256, r = rng(3);
    const ref = { width: size, height: size, data: new Float32Array(size * size * 3) };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const v = 0.5 + 0.2 * Math.sin(x / 2.1) * Math.cos(y / 3.3) + 0.1 * (r() - 0.5);
        ref.data.fill(v, (y * size + x) * 3, (y * size + x) * 3 + 3);
    }
    const soft = blur(ref, 0.6);
    const fit = fitSharpen(soft, ref, { coring: 0 });
    assert.ok(fit.detail[0] < 0.8, `softened: ${fit.detail}`);
    assert.ok(fit.gains[0] > 0.3, `fine detail is boosted: ${fit.gains}`);
    sharpen(soft, fit.gains, fit.cores);
    const after = fitSharpen(soft, ref, { coring: 0 });
    assert.ok(Math.abs(after.detail[0] - 1) < 0.15, `fine detail matches after sharpening: ${after.detail}`);
});

test('sharpening is capped where the reference has far more detail (a blurred frame)', () => {
    const size = 256, r = rng(5);
    const ref = { width: size, height: size, data: new Float32Array(size * size * 3) };
    for (let i = 0; i < size * size; i++) ref.data.fill(0.5 + 0.3 * (r() - 0.5), i * 3, i * 3 + 3);
    const fit = fitSharpen(blur(blur(ref, 1), 1), ref, { coring: 0 });
    assert.ok(fit.detail[0] < 0.5, `blurred: ${fit.detail}`);
    for (const g of fit.gains) assert.ok(g <= MAX_SHARPEN, `gain within the cap: ${fit.gains}`);
});

test('denoising keeps texture that stands above the noise (sigma filter, not wavelet shrinkage)', () => {
    const w = 128, h = 128, r = rng(11);
    const S = 1e-4, O = 1e-6, sigma = Math.sqrt(S * 0.2 + O);
    // Checkerboard of 2-px cells, ±5σ, on a flat grey
    const clean = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) clean.fill(0.2 + ((((x >> 1) + (y >> 1)) & 1) ? 5 : -5) * sigma, (y * w + x) * 3, (y * w + x) * 3 + 3);
    const img = { width: w, height: h, data: Float32Array.from(clean, v => Math.max(0, v + Math.sqrt(S * v + O) * gauss(r))) };
    denoise(img, [[S, O], [S, O], [S, O]]);
    let amp = 0, err = 0;
    for (let y = 8; y < h - 8; y++) for (let x = 8; x < w - 8; x++) {
        const i = (y * w + x) * 3 + 1, sign = (((x >> 1) + (y >> 1)) & 1) ? 1 : -1;
        amp += sign * (img.data[i] - 0.2);
        err += (img.data[i] - clean[i]) ** 2;
    }
    const n = (w - 16) * (h - 16);
    assert.ok(amp / n > 4 * sigma, `texture amplitude kept: ${(amp / n / sigma).toFixed(2)}σ of 5σ`);
    assert.ok(Math.sqrt(err / n) < 0.8 * sigma, `noise reduced: ${(Math.sqrt(err / n) / sigma).toFixed(2)}σ`);
});

test('the noise curve measures noise per brightness, not texture', () => {
    const w = 256, h = 256, r = rng(13);
    const plane = new Float32Array(w * h), lum = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dark = x < w / 2;
        lum[y * w + x] = dark ? 10 : 100;
        plane[y * w + x] = lum[y * w + x] + (dark ? 0.5 : 2) * gauss(r) + (y < 32 ? 20 * Math.sin(x) : 0);
    }
    const sigma = noiseCurve(plane, lum, w, h);
    assert.ok(Math.abs(sigma(10) - 0.5) < 0.15 && Math.abs(sigma(100) - 2) < 0.5, `σ(dark) ${sigma(10)}, σ(bright) ${sigma(100)}`);
});

test('clipped highlights stay white through white balance, not magenta', () => {
    const tags = {
        ColorMatrix1: '1.1648 -0.6376 0.0243 -0.3076 1.1736 0.1491 0.0019 0.1399 0.6466',
        ForwardMatrix1: '0.552 0.3075 0.1048 0.1175 0.9251 -0.0425 -0.0803 -0.5379 1.4432',
        CalibrationIlluminant1: 21, AsShotNeutral: '0.5 1 0.7',
    };
    const m = cameraToSrgb(tags);
    const img = { width: 1, height: 1, data: Float32Array.of(1, 1, 1) };
    clipToWhite(img, m.neutral);
    const rgb = m.map(row => row[0] * img.data[0] + row[1] * img.data[1] + row[2] * img.data[2]);
    for (const v of rgb) assert.ok(Math.abs(v - rgb[1]) < 0.02 * rgb[1], `clipped white is neutral: ${rgb}`);
});

test('camera detail: the JPEG\'s fine detail replaces the RAW\'s, tone and colour stay, clipped areas keep the RAW\'s', () => {
    const w = 128, h = 128, r = rng(17);
    const texture = new Float32Array(w * h).map(() => 0.08 * (r() - 0.5));
    const jpeg = { width: w, height: h, data: new Float32Array(w * h * 3) };
    const ours = { width: w, height: h, data: new Float32Array(w * h * 3) };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x, clipped = x >= 96;
        const jv = clipped ? 1 : 0.5 + texture[p];
        jpeg.data.set([jv, jv, jv], p * 3);
        // Ours: no fine detail, a warmer colour; in the clipped strip it has its own texture
        const ov = clipped ? 0.9 + texture[p] : 0.5;
        ours.data.set([ov + 0.05, ov, ov - 0.05], p * 3);
    }
    transferDetail(ours, jpeg);
    let err = 0, warm = 0, kept = 0, n = 0, m = 0;
    for (let y = 16; y < h - 16; y++) for (let x = 16; x < 80; x++) {
        const p = y * w + x;
        err += (ours.data[p * 3 + 1] - jpeg.data[p * 3 + 1]) ** 2; warm += ours.data[p * 3] - ours.data[p * 3 + 2]; n++;
    }
    for (let y = 16; y < h - 16; y++) for (let x = 108; x < w - 4; x++) { const p = y * w + x; kept += (ours.data[p * 3 + 1] - 0.9 - texture[p]) ** 2; m++; }
    assert.ok(Math.sqrt(err / n) < 0.01, `JPEG detail taken: ${Math.sqrt(err / n)}`);
    assert.ok(Math.abs(warm / n - 0.1) < 0.005, 'colour stays the RAW\'s');
    assert.ok(Math.sqrt(kept / m) < 0.005, `RAW detail kept where the JPEG is clipped: ${Math.sqrt(kept / m)}`);
});
