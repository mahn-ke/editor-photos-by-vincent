import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cameraToSrgb, denoise, fitSharpen, sharpen } from '../src/raw.js';

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
    denoise(img, [[S, O], [S, O], [S, O]], { luma: 2.5, chroma: 4 });
    const rms = (a) => Math.sqrt(a.reduce((s, v, i) => s + (v - clean[i]) ** 2, 0) / a.length);
    assert.ok(rms(img.data) < rms(noisy) * 0.5, `error ${rms(img.data)} vs noisy ${rms(noisy)}`);
    const at = (x, y) => img.data[(y * w + x) * 3 + 1];
    assert.ok(Math.abs(at(10, 30) - 0.05) < 0.01 && Math.abs(at(110, 30) - 0.4) < 0.02, 'levels kept');
    assert.ok(at(w / 2 + 2, 30) - at(w / 2 - 3, 30) > 0.3, 'edge kept');
});

test('sharpening is fitted so a softened image regains the reference detail', () => {
    const size = 256, r = rng(3);
    const ref = { width: size, height: size, data: new Float32Array(size * size * 3) };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const v = 0.5 + 0.2 * Math.sin(x / 2.1) * Math.cos(y / 3.3) + 0.1 * (r() - 0.5);
        ref.data.fill(v, (y * size + x) * 3, (y * size + x) * 3 + 3);
    }
    // Soften: 3×3 box blur
    const soft = { width: size, height: size, data: new Float32Array(ref.data.length) };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += ref.data[((Math.min(size - 1, Math.max(0, y + dy))) * size + Math.min(size - 1, Math.max(0, x + dx))) * 3];
        soft.data.fill(s / 9, (y * size + x) * 3, (y * size + x) * 3 + 3);
    }
    const fit = fitSharpen(soft, ref, { coring: 0 });
    assert.ok(fit.detail[0] < 0.8, `softened: ${fit.detail}`);
    assert.ok(fit.gains[0] > 0.3, `fine detail is boosted: ${fit.gains}`);
    sharpen(soft, fit.gains, fit.cores);
    const after = fitSharpen(soft, ref, { coring: 0 });
    assert.ok(Math.abs(after.detail[0] - 1) < 0.15, `fine detail matches after sharpening: ${after.detail}`);
});
