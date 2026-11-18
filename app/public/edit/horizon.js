// Estimates how far a photo is tilted from its long near-level and near-plumb lines.
// Edge pixels (Sobel on a ≤800 px luminance copy) vote Hough-style: for each candidate
// angle within ±RANGE we count how concentrated the edge positions become along lines
// of that slope. Long straight lines (horizon, roofs, building edges) make one angle
// stand out. Vertical edges are rotated into the same frame and weighted less, since
// perspective tilts them. Returns the recipe angle that levels the photo
// (positive = rotate clockwise) and a 0..1 confidence.

import { luminance, resize } from './pipeline.js';

const RANGE = 10;
const STEP = 0.1;

function edgePoints(img) {
    const scale = Math.min(1, 800 / Math.max(img.width, img.height));
    const small = scale < 1 ? resize(img, Math.round(img.width * scale), Math.round(img.height * scale)) : img;
    const { width: w, height: h } = small;
    const L = luminance(small);
    const horizontal = [];
    const vertical = [];
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const gx = (L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1]) - (L[i - w - 1] + 2 * L[i - 1] + L[i + w - 1]);
            const gy = (L[i + w - 1] + 2 * L[i + w] + L[i + w + 1]) - (L[i - w - 1] + 2 * L[i - w] + L[i - w + 1]);
            const mag = Math.hypot(gx, gy);
            if (mag < 0.25) continue;
            // Gradient mostly vertical → part of a near-horizontal edge, and vice versa
            if (Math.abs(gy) > Math.abs(gx) * 3) horizontal.push(x - w / 2, y - h / 2, mag);
            else if (Math.abs(gx) > Math.abs(gy) * 3) vertical.push(-(y - h / 2), x - w / 2, mag); // rotated by 90°
        }
    }
    return { horizontal, vertical, size: Math.hypot(w, h) };
}

// Sum of squared line strengths for lines with the given slope
function concentration(points, tan, offset, bins) {
    const acc = new Float64Array(bins);
    for (let k = 0; k < points.length; k += 3) {
        const b = Math.round(points[k + 1] - points[k] * tan) + offset;
        if (b >= 0 && b < bins) acc[b] += points[k + 2];
    }
    let sum = 0;
    for (let b = 0; b < bins; b++) sum += acc[b] * acc[b];
    return sum;
}

export function detectTilt(img) {
    const { horizontal, vertical, size } = edgePoints(img);
    if (horizontal.length + vertical.length < 60) return { angle: 0, confidence: 0 };
    const offset = Math.ceil(size);
    const bins = offset * 2 + 1;
    const n = Math.round((2 * RANGE) / STEP) + 1;
    const scores = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const tan = Math.tan(((i * STEP - RANGE) * Math.PI) / 180);
        scores[i] = concentration(horizontal, tan, offset, bins) + 0.6 * concentration(vertical, tan, offset, bins);
    }
    let peak = 0;
    for (let i = 1; i < n; i++) if (scores[i] > scores[peak]) peak = i;
    const sorted = Array.from(scores).sort((a, b) => a - b);
    const median = sorted[Math.floor(n / 2)];
    const prominence = median > 0 ? scores[peak] / median - 1 : 0;
    const confidence = Math.max(0, Math.min(1, prominence / 1.5));
    // A line with slope tan(θ) in y-down coordinates is levelled by rotating by -θ
    const theta = peak * STEP - RANGE;
    const angle = Math.round(-theta * 10) / 10 || 0;
    return { angle, confidence: Math.round(confidence * 100) / 100 };
}
