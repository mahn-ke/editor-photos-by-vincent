// Per-photo automatic edits ("Enhance", "Dynamic", "Warm", "Cool"), computed from the
// photo's own statistics. Shared by the editor's Suggestions tab and the suggestion engine.

import { luminance } from './pipeline.js';

export function measure(img) {
    const L = luminance(img);
    const n = L.length;
    const hist = new Uint32Array(256);
    let sat = 0;
    let rg = 0;
    let yb = 0;
    const d = img.data;
    for (let p = 0, j = 0; p < n; p++, j += 3) {
        hist[Math.min(255, Math.max(0, Math.round(L[p] * 255)))]++;
        const max = Math.max(d[j], d[j + 1], d[j + 2]);
        const min = Math.min(d[j], d[j + 1], d[j + 2]);
        sat += max - min;
        rg += d[j] - d[j + 1];
        yb += 0.5 * (d[j] + d[j + 1]) - d[j + 2];
    }
    const percentile = (q) => {
        let acc = 0;
        const target = q * n;
        for (let i = 0; i < 256; i++) {
            acc += hist[i];
            if (acc >= target) return i / 255;
        }
        return 1;
    };
    return {
        p01: percentile(0.01), p05: percentile(0.05), p25: percentile(0.25), p50: percentile(0.5),
        p75: percentile(0.75), p95: percentile(0.95), p99: percentile(0.99),
        clippedHigh: hist.slice(250).reduce((a, b) => a + b, 0) / n,
        clippedLow: hist.slice(0, 4).reduce((a, b) => a + b, 0) / n,
        saturation: sat / n,
        castRG: rg / n,
        castYB: yb / n,
    };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = v => Math.round(v * 100) / 100;

export function enhanceAdjust(stats) {
    const a = {};
    if (stats.p01 > 0.05) a.blackPoint = r2(clamp((stats.p01 - 0.02) * 4, 0, 0.5));
    if (stats.p99 < 0.93) a.whitePoint = r2(clamp((0.97 - stats.p99) * 2.5, 0, 0.5));
    if (stats.p25 < 0.22) a.shadows = r2(clamp((0.27 - stats.p25) * 1.6, 0, 0.45));
    if (stats.clippedHigh > 0.01) a.highlights = r2(-clamp(stats.clippedHigh * 8, 0.05, 0.4));
    const mid = 0.45 - stats.p50;
    if (Math.abs(mid) > 0.05) a.brightness = r2(clamp(mid * 1.1, -0.3, 0.35));
    a.pop = 0.15;
    if (stats.saturation < 0.18) a.saturation = r2(clamp((0.2 - stats.saturation) * 1.2, 0, 0.15));
    return a;
}

export function autoRecipes(stats) {
    const enhance = enhanceAdjust(stats);
    const cast = clamp(-stats.castYB * 1.5, -0.2, 0.2);
    return {
        enhance: { name: 'Enhance', adjust: enhance },
        dynamic: { name: 'Dynamic', adjust: { ...enhance, contrast: 0.25, saturation: r2((enhance.saturation ?? 0) + 0.25), pop: 0.3 } },
        warm: { name: 'Warm', adjust: { ...enhance, warmth: r2(0.3 + Math.max(0, cast)) } },
        cool: { name: 'Cool', adjust: { ...enhance, warmth: r2(-0.3 + Math.min(0, cast)) } },
    };
}
