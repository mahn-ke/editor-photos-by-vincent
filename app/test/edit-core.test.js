import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constrainRect, defaultRect, fitsInside, maxRectAt, outputMapping, outputSize } from '../public/edit/geometry.js';
import { applyTone, createImage, luminance, render } from '../public/edit/pipeline.js';
import { defaultRecipe, describeRecipe, isIdentity, normalizeRecipe } from '../public/edit/recipe.js';

function chart(width = 64, height = 48) {
    // Horizontal grey ramp in the top half, coloured patches in the bottom half
    const img = createImage(width, height);
    const patches = [[0.8, 0.55, 0.45], [0.25, 0.45, 0.8], [0.3, 0.6, 0.3], [0.9, 0.85, 0.2]];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const j = (y * width + x) * 3;
            if (y < height / 2) {
                const v = x / (width - 1);
                img.data[j] = v; img.data[j + 1] = v; img.data[j + 2] = v;
            } else {
                const p = patches[Math.floor((x / width) * patches.length)];
                img.data.set(p, j);
            }
        }
    }
    return img;
}

const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const meanLuma = img => mean(Array.from(luminance(img)));
const saturationOf = img => {
    let s = 0;
    for (let j = 0; j < img.data.length; j += 3) s += Math.max(img.data[j], img.data[j + 1], img.data[j + 2]) - Math.min(img.data[j], img.data[j + 1], img.data[j + 2]);
    return s / (img.data.length / 3);
};
const withAdjust = values => normalizeRecipe({ adjust: values });
const tone = (img, values) => applyTone({ ...img, data: Float32Array.from(img.data) }, withAdjust(values));

test('recipes are clamped and unknown values dropped', () => {
    const r = normalizeRecipe({ adjust: { contrast: 5, pop: -1, nonsense: 3 }, geometry: { angle: 90, rotate90: -1, aspect: 'weird' }, filter: { id: 'x'.repeat(99) } });
    assert.equal(r.adjust.contrast, 1);
    assert.equal(r.adjust.pop, 0);
    assert.equal(r.adjust.nonsense, undefined);
    assert.equal(r.geometry.angle, 45);
    assert.equal(r.geometry.rotate90, 3);
    assert.equal(r.geometry.aspect, 'free');
    assert.equal(r.filter.id, 'none');
    assert.ok(isIdentity(defaultRecipe()));
    assert.ok(!isIdentity({ geometry: { angle: 0.1 } }));
    assert.equal(describeRecipe({ geometry: { angle: -4.7 }, adjust: { pop: 0.2 } }), 'Straighten −4.7°, Pop +0.20');
});

test('the empty recipe leaves pixels unchanged', () => {
    const img = chart();
    const out = render(img, defaultRecipe());
    assert.equal(out.width, img.width);
    assert.equal(out.height, img.height);
    let maxDiff = 0;
    for (let j = 0; j < img.data.length; j++) maxDiff = Math.max(maxDiff, Math.abs(out.data[j] - img.data[j]));
    assert.ok(maxDiff < 1e-5, `max diff ${maxDiff}`);
});

test('sliders move the image in the expected direction', () => {
    const img = chart();
    const base = meanLuma(img);
    assert.ok(meanLuma(tone(img, { brightness: 0.6 })) > base + 0.03);
    assert.ok(meanLuma(tone(img, { brightness: -0.6 })) < base - 0.03);
    assert.ok(meanLuma(tone(img, { shadows: 0.8 })) > base);
    assert.ok(meanLuma(tone(img, { whitePoint: 0.8 })) > base);
    assert.ok(meanLuma(tone(img, { blackPoint: 0.8 })) < base);
    assert.ok(saturationOf(tone(img, { saturation: 0.7 })) > saturationOf(img));
    assert.ok(saturationOf(tone(img, { saturation: -1 })) < 0.01, 'saturation -1 is greyscale');
    const warm = tone(img, { warmth: 1 });
    const j = (40 * 64 + 2) * 3; // a patch pixel
    assert.ok(warm.data[j] > img.data[j] && warm.data[j + 2] < img.data[j + 2], 'warmth shifts red up, blue down');
    const vignetted = tone(img, { vignette: 1 });
    assert.ok(vignetted.data[0] < img.data[0] + 1e-6 && Math.abs(vignetted.data[(24 * 64 + 32) * 3] - img.data[(24 * 64 + 32) * 3]) < 0.02);
});

test('contrast spreads the grey ramp without clipping it', () => {
    const img = chart();
    const out = tone(img, { contrast: 1 });
    const dark = out.data[(5 * 64 + 10) * 3];
    const light = out.data[(5 * 64 + 54) * 3];
    assert.ok(dark < img.data[(5 * 64 + 10) * 3]);
    assert.ok(light > img.data[(5 * 64 + 54) * 3]);
    assert.ok(out.data[(5 * 64 + 63) * 3] <= 1 && out.data[(5 * 64) * 3] >= 0);
});

test('the largest rotated crop stays inside the image', () => {
    for (const angle of [0, 3.5, -12, 30, 45]) {
        for (const aspect of [4 / 3, 1, 9 / 16]) {
            const rect = { cx: 2000, cy: 1500, ...maxRectAt(4000, 3000, angle, aspect) };
            assert.ok(fitsInside(rect, 4000, 3000, angle), `${angle}° ${aspect}`);
            const bigger = { ...rect, w: rect.w * 1.01, h: rect.h * 1.01 };
            assert.ok(!fitsInside(bigger, 4000, 3000, angle), 'and is maximal');
        }
    }
    // At 0° with the image's own aspect the default crop is the whole image
    const full = defaultRect(4000, 3000, 0);
    assert.equal(Math.round(full.w), 4000);
    assert.equal(Math.round(full.h), 3000);
});

test('constraining moves a crop inwards before shrinking it', () => {
    const moved = constrainRect({ cx: 3900, cy: 1500, w: 1000, h: 750 }, 4000, 3000, 0);
    assert.equal(moved.w, 1000);
    assert.equal(moved.cx, 3500);
    const shrunk = constrainRect({ cx: 2000, cy: 1500, w: 4000, h: 3000 }, 4000, 3000, 5);
    assert.ok(shrunk.w < 4000 && Math.abs(shrunk.w / shrunk.h - 4 / 3) < 1e-9);
    assert.ok(fitsInside(shrunk, 4000, 3000, 5));
});

test('output mapping undoes 90° rotations', () => {
    const p = [0, 0];
    // Rotated 90° clockwise: the output's top-left comes from the source's bottom-left
    const map = outputMapping({ rotate90: 1, angle: 0, crop: null }, 400, 300, 300, 400);
    map(0, 0, p);
    assert.ok(Math.abs(p[0] - 0.5) < 1e-9 && Math.abs(p[1] - 299.5) < 1e-9, JSON.stringify(p));
    assert.deepEqual(outputSize({ rotate90: 1, angle: 0, crop: null }, 400, 300), { width: 300, height: 400 });
    assert.deepEqual(outputSize({ rotate90: 0, angle: 0, crop: { cx: 0.5, cy: 0.5, w: 0.5, h: 0.5 } }, 400, 300), { width: 200, height: 150 });
});

test('straightening a tilted line makes it level', () => {
    // A dark line rising 4° to the right; rotating by -4° must flatten it
    const W = 200, H = 120;
    const img = createImage(W, H);
    img.data.fill(1);
    const tan = Math.tan((4 * Math.PI) / 180);
    for (let x = 0; x < W; x++) {
        const y = Math.round(H / 2 - (x - W / 2) * tan);
        for (let t = -1; t <= 1; t++) img.data.fill(0, ((y + t) * W + x) * 3, ((y + t) * W + x) * 3 + 3);
    }
    const out = render(img, { geometry: { angle: 4 } });
    const rowOfLine = x => {
        let best = 0, bestV = 2;
        for (let y = 0; y < out.height; y++) {
            const v = out.data[(y * out.width + x) * 3];
            if (v < bestV) { bestV = v; best = y; }
        }
        return best;
    };
    assert.ok(Math.abs(rowOfLine(10) - rowOfLine(out.width - 10)) <= 1, `${rowOfLine(10)} vs ${rowOfLine(out.width - 10)}`);
});
