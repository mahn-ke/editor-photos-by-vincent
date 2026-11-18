import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chart, cityscape } from '../e2e/make-test-images.js';
import { detectTilt } from '../public/edit/horizon.js';
import { fromRGB, render } from '../public/edit/pipeline.js';

const toImg = ({ width, height, px }) => fromRGB(px, width, height);
// A level scene photographed tilted: rotate everything by -angle
const tilted = (img, angle) => render(img, { geometry: { angle: -angle } });

test('recovers the tilt of a rotated test chart exactly', () => {
    const level = toImg(chart(1200, 900, 0));
    assert.equal(detectTilt(level).angle, 0);
    for (const angle of [3, -2.4, 6.5, 0.7]) {
        const result = detectTilt(tilted(level, angle));
        assert.ok(Math.abs(result.angle - angle) <= 0.2, `${angle}: ${JSON.stringify(result)}`);
        assert.ok(result.confidence >= 0.3);
    }
});

test('measures rotations of a busy cityscape consistently', () => {
    // The generated skyline has slanted window patterns; what matters is that a rotation
    // shifts the reading by exactly that rotation
    const level = toImg(cityscape(1200, 800, 0));
    const base = detectTilt(level).angle;
    for (const angle of [3, -2.4, 6.5]) {
        const result = detectTilt(tilted(level, angle));
        assert.ok(Math.abs(result.angle - base - angle) <= 0.3, `${angle}: ${JSON.stringify(result)} base ${base}`);
    }
});

test('a featureless image gets no confident angle', () => {
    const flat = { width: 300, height: 200, data: new Float32Array(300 * 200 * 3).fill(0.5) };
    assert.equal(detectTilt(flat).confidence, 0);
});
