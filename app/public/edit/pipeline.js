// Pixel pipeline shared by the browser preview (Web Worker) and the server renderer
// (Node worker). Images are { width, height, data: Float32Array RGB in 0..1, sRGB-encoded }.
// One implementation means the preview and the saved result cannot drift apart.

import { ADJUST_KEYS, normalizeRecipe } from './recipe.js';
import { outputMapping, outputSize } from './geometry.js';
import { FILTERS } from './filters.js';
import './learned-presets.js';
import { applyClarityDehaze, applyColour, applyExposure, applyFinish, applyLevelsCurves } from './advanced.js';

// Strength constants, tuned against Google Photos renders by the calibration harness
export const CAL = {
    warmth: 0.22, tint: 0.16,
    brightness: 0.85, contrast: 0.9, whitePoint: 0.22, blackPoint: 0.12,
    highlights: 0.55, shadows: 0.75, hdr: 0.6,
    saturationUp: 0.85, saturationDown: 1,
    skinTone: 0.6, blueTone: 0.7,
    pop: 1.4, popVibrance: 0.15,
    vignette: 0.65,
    baseRadius: 0.035, detailRadius: 0.006,
};

export function createImage(width, height) {
    return { width, height, data: new Float32Array(width * height * 3) };
}

export function fromRGBA8(rgba, width, height) {
    const img = createImage(width, height);
    const d = img.data;
    for (let i = 0, j = 0; j < d.length; i += 4, j += 3) {
        d[j] = rgba[i] / 255;
        d[j + 1] = rgba[i + 1] / 255;
        d[j + 2] = rgba[i + 2] / 255;
    }
    return img;
}

export function fromRGB(buffer, width, height, maxValue = 255) {
    const img = createImage(width, height);
    const d = img.data;
    for (let j = 0; j < d.length; j++) d[j] = buffer[j] / maxValue;
    return img;
}

// Ordered 4×4 dither keeps smooth skies free of banding when going back to 8 bits
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16 - 0.5);

// Rounds exactly like toRGB8 (the saved file), so the preview shows the same pixels
export function toRGBA8(img, out = new Uint8ClampedArray(img.width * img.height * 4)) {
    const { width, data } = img;
    for (let p = 0, j = 0, i = 0; j < data.length; p++, j += 3, i += 4) {
        const x = p % width;
        const y = (p - x) / width;
        const dither = BAYER[(y & 3) * 4 + (x & 3)];
        out[i] = Math.round(data[j] * 255 + dither);
        out[i + 1] = Math.round(data[j + 1] * 255 + dither);
        out[i + 2] = Math.round(data[j + 2] * 255 + dither);
        out[i + 3] = 255;
    }
    return out;
}

export function toRGB8(img) {
    const out = new Uint8Array(img.width * img.height * 3);
    const { width, data } = img;
    for (let j = 0, p = 0; j < data.length; j += 3, p++) {
        const x = p % width;
        const y = (p - x) / width;
        const dither = BAYER[(y & 3) * 4 + (x & 3)];
        for (let c = 0; c < 3; c++) {
            const v = Math.round(data[j + c] * 255 + dither);
            out[j + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
    }
    return out;
}

// ---- Resampling -------------------------------------------------------------

function sampleBilinear(img, x, y, out, o) {
    const { width, height, data } = img;
    const fx = Math.min(Math.max(x - 0.5, 0), width - 1);
    const fy = Math.min(Math.max(y - 0.5, 0), height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const i00 = (y0 * width + x0) * 3;
    const i10 = (y0 * width + x1) * 3;
    const i01 = (y1 * width + x0) * 3;
    const i11 = (y1 * width + x1) * 3;
    for (let c = 0; c < 3; c++) {
        const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * ax;
        const bottom = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * ax;
        out[o + c] = top + (bottom - top) * ay;
    }
}

export function resize(img, width, height) {
    if (img.width === width && img.height === height) return img;
    // Box-average first when shrinking a lot, so previews don't alias
    let src = img;
    while (src.width >= width * 2 && src.height >= height * 2) src = halve(src);
    const out = createImage(width, height);
    const sx = src.width / width;
    const sy = src.height / height;
    for (let v = 0; v < height; v++) {
        for (let u = 0; u < width; u++) sampleBilinear(src, (u + 0.5) * sx, (v + 0.5) * sy, out.data, (v * width + u) * 3);
    }
    return out;
}

function halve(img) {
    const width = Math.floor(img.width / 2);
    const height = Math.floor(img.height / 2);
    const out = createImage(width, height);
    const s = img.data;
    const d = out.data;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const a = ((2 * y) * img.width + 2 * x) * 3;
            const b = a + img.width * 3;
            const o = (y * width + x) * 3;
            for (let c = 0; c < 3; c++) d[o + c] = (s[a + c] + s[a + 3 + c] + s[b + c] + s[b + 3 + c]) / 4;
        }
    }
    return out;
}

// Rotates, straightens and crops in one resampling pass (the image scales up to cover
// the crop, exactly like the crop UI shows it)
export function applyGeometry(img, geometry, sourceSize, maxPixels = Infinity) {
    const W0 = sourceSize?.width ?? img.width;
    const H0 = sourceSize?.height ?? img.height;
    const { width, height } = outputSize(geometry, W0, H0, maxPixels);
    const map = outputMapping(geometry, W0, H0, width, height);
    const out = createImage(width, height);
    const kx = img.width / W0;
    const ky = img.height / H0;
    const p = [0, 0];
    // Sample from a pre-shrunk source when the output is much smaller
    let src = img;
    let scale = 1;
    const ratio = Math.min((W0 * H0) / (width * height), (img.width * img.height) / (width * height));
    while (ratio / (scale * scale) >= 4 && src.width > 2 && src.height > 2) {
        src = halve(src);
        scale *= 2;
    }
    const fx = (src.width / img.width) * kx;
    const fy = (src.height / img.height) * ky;
    for (let v = 0; v < height; v++) {
        for (let u = 0; u < width; u++) {
            map(u, v, p);
            sampleBilinear(src, p[0] * fx, p[1] * fy, out.data, (v * width + u) * 3);
        }
    }
    return out;
}

// ---- Filters on single channels --------------------------------------------

// Three box blurs approximate a Gaussian; O(n) per pass regardless of radius
export function blurChannel(src, width, height, radius) {
    const r = Math.max(1, Math.round(radius));
    let a = Float32Array.from(src);
    let b = new Float32Array(src.length);
    for (let pass = 0; pass < 3; pass++) {
        boxH(a, b, width, height, r);
        boxV(b, a, width, height, r);
    }
    return a;
}

function boxH(src, dst, width, height, r) {
    const norm = 1 / (2 * r + 1);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        let acc = src[row] * (r + 1);
        for (let x = 1; x <= r; x++) acc += src[row + Math.min(x, width - 1)];
        for (let x = 0; x < width; x++) {
            dst[row + x] = acc * norm;
            acc += src[row + Math.min(x + r + 1, width - 1)] - src[row + Math.max(x - r, 0)];
        }
    }
}

function boxV(src, dst, width, height, r) {
    const norm = 1 / (2 * r + 1);
    for (let x = 0; x < width; x++) {
        let acc = src[x] * (r + 1);
        for (let y = 1; y <= r; y++) acc += src[Math.min(y, height - 1) * width + x];
        for (let y = 0; y < height; y++) {
            dst[y * width + x] = acc * norm;
            acc += src[Math.min(y + r + 1, height - 1) * width + x] - src[Math.max(y - r, 0) * width + x];
        }
    }
}

export function luminance(img) {
    const n = img.width * img.height;
    const L = new Float32Array(n);
    const d = img.data;
    for (let p = 0, j = 0; p < n; p++, j += 3) L[p] = 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
    return L;
}

const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

// ---- Tone curve (brightness, contrast, black and white point) ---------------

const LUT_SIZE = 4096;

export function buildToneLut(adjust) {
    const lut = new Float32Array(LUT_SIZE + 1);
    const b = adjust.brightness * CAL.brightness;
    const c = adjust.contrast * CAL.contrast;
    const wp = adjust.whitePoint * CAL.whitePoint;
    const bp = adjust.blackPoint * CAL.blackPoint;
    const gamma = Math.pow(2, -b);
    for (let i = 0; i <= LUT_SIZE; i++) {
        let v = i / LUT_SIZE;
        // Black point: positive deepens shadows, negative lifts (fades) them
        v = bp >= 0 ? Math.max(0, (v - bp) / (1 - bp)) : v * (1 + bp) - bp;
        // White point: positive brightens whites, negative dims them
        v = wp >= 0 ? v / (1 - wp) : v * (1 + wp);
        v = Math.min(1, Math.max(0, v)); // the curves below are defined on 0..1
        // Brightness: midtone gamma with highlights protected
        v = Math.pow(Math.max(v, 0), gamma);
        // Contrast: S-curve around mid-grey that never clips
        if (c > 0) {
            const s = v < 0.5 ? 0.5 * Math.pow(2 * v, 1 + c) : 1 - 0.5 * Math.pow(2 * (1 - v), 1 + c);
            v = s;
        } else if (c < 0) {
            v = 0.5 + (v - 0.5) * (1 + c * 0.6);
        }
        lut[i] = Math.min(1, Math.max(0, v));
    }
    return lut;
}

function applyLut(lut, v) {
    if (v <= 0) return lut[0];
    if (v >= 1) return lut[LUT_SIZE];
    const f = v * LUT_SIZE;
    const i = Math.floor(f);
    return lut[i] + (lut[i + 1] - lut[i]) * (f - i);
}

// ---- Main entry -------------------------------------------------------------

// Effective adjust values: the user's sliders plus the chosen filter scaled by strength
export function effectiveAdjust(recipe) {
    const filter = FILTERS[recipe.filter.id];
    const strength = filter ? recipe.filter.strength : 0;
    const adjust = { ...recipe.adjust };
    if (filter?.adjust) {
        for (const key of ADJUST_KEYS) {
            if (filter.adjust[key]) adjust[key] = Math.min(1, Math.max(key === 'hdr' || key === 'pop' || key === 'vignette' ? 0 : -1, adjust[key] + filter.adjust[key] * strength));
        }
    }
    return { adjust, mono: filter?.mono ? strength : 0, split: filter?.split ? { ...filter.split, amount: (filter.split.amount ?? 1) * strength } : null };
}

// Applies colour and tone edits in place. `masks` (optional) feed the tools.
export function applyTone(img, recipe, { masks = null, tools = null } = {}) {
    const { width, height, data } = img;
    const n = width * height;
    const { adjust, mono, split } = effectiveAdjust(recipe);
    const diag = Math.hypot(width, height);

    // 1. White balance as channel gains (linear gains expressed in gamma space)
    const warm = adjust.warmth * CAL.warmth;
    const tint = adjust.tint * CAL.tint;
    if (warm || tint) {
        const gr = Math.pow(1 + warm, 1 / 2.2);
        const gg = Math.pow(1 - tint, 1 / 2.2);
        const gb = Math.pow(1 - warm, 1 / 2.2);
        const norm = 1 / (0.2126 * gr + 0.7152 * gg + 0.0722 * gb);
        for (let j = 0; j < data.length; j += 3) {
            data[j] *= gr * norm;
            data[j + 1] *= gg * norm;
            data[j + 2] *= gb * norm;
        }
    }

    const adv = recipe.advanced;
    const helpers = { blurChannel, luminance };
    if (adv) applyExposure(img, adv);

    // 2. Local tone: shadows, highlights and HDR against a smooth luminance base
    const needsBase = adjust.shadows || adjust.highlights || adjust.hdr;
    if (needsBase) {
        const L = luminance(img);
        const B = blurChannel(L, width, height, CAL.baseRadius * diag);
        const sh = adjust.shadows * CAL.shadows;
        const hi = adjust.highlights * CAL.highlights;
        const hdr = adjust.hdr * CAL.hdr;
        for (let p = 0, j = 0; p < n; p++, j += 3) {
            const l = L[p];
            if (l <= 1e-5) continue;
            const base = Math.max(B[p], 1e-4);
            let target = l;
            const ws = 1 - smoothstep(0, 0.55, base);
            const wh = smoothstep(0.45, 1, base);
            if (sh) target += sh > 0 ? sh * ws * ws * (1 - target) * 0.9 : sh * ws * target * 0.9;
            if (hi) target += hi > 0 ? hi * wh * (1 - target) * 0.7 : hi * wh * wh * target * 0.6;
            if (hdr) {
                // Compress the base towards mid-grey, keep (slightly boost) local detail
                const detail = l / base;
                const compressed = Math.pow(base, 1 - 0.45 * hdr) * Math.pow(0.45, 0.45 * hdr);
                target = target * (1 - hdr) + compressed * Math.pow(detail, 1 + 0.25 * hdr) * hdr;
            }
            const k = target / l;
            data[j] *= k;
            data[j + 1] *= k;
            data[j + 2] *= k;
        }
    }

    if (adv) applyClarityDehaze(img, adv, helpers);

    // 3. Global tone curve
    const toneActive = adjust.brightness || adjust.contrast || adjust.whitePoint || adjust.blackPoint;
    if (toneActive) {
        const lut = buildToneLut(adjust);
        for (let j = 0; j < data.length; j++) data[j] = applyLut(lut, data[j]);
    }

    // 4. Pop: local contrast on midtones plus a little vibrance
    if (adjust.pop) {
        const L = luminance(img);
        const B = blurChannel(L, width, height, CAL.detailRadius * diag * 4);
        const amount = adjust.pop * CAL.pop;
        for (let p = 0, j = 0; p < n; p++, j += 3) {
            const l = L[p];
            const midtone = 1 - Math.abs(2 * l - 1) * 0.7;
            const delta = (l - B[p]) * amount * midtone;
            data[j] += delta;
            data[j + 1] += delta;
            data[j + 2] += delta;
        }
    }

    // 5. Colour: saturation, vibrance from pop, skin and blue tones, filter mono/split
    const sat = adjust.saturation;
    const vib = adjust.pop * CAL.popVibrance;
    const skin = adjust.skinTone * CAL.skinTone;
    const blue = adjust.blueTone * CAL.blueTone;
    if (sat || vib || skin || blue || mono || split) {
        for (let j = 0; j < data.length; j += 3) {
            let r = data[j];
            let g = data[j + 1];
            let b = data[j + 2];
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const chroma = max - min;
            let factor = 1 + (sat > 0 ? sat * CAL.saturationUp : sat * CAL.saturationDown);
            if (vib) factor += vib * (1 - Math.min(1, chroma * 2));
            if ((skin || blue) && chroma > 0.02) {
                const hue = hueOf(r, g, b, max, chroma);
                const satWeight = Math.min(1, chroma * 4);
                if (skin) factor += skin * bandWeight(hue, 25, 22) * satWeight;
                if (blue) factor += blue * bandWeight(hue, 212, 32) * satWeight;
            }
            if (factor !== 1) {
                // Limit so no channel clips (keeps highlights from going flat)
                let f = factor;
                if (f > 1 && chroma > 0) {
                    if (max > l) f = Math.min(f, (1 - l) / (max - l));
                    if (min < l) f = Math.min(f, l / (l - min));
                    f = Math.max(1, f);
                }
                r = l + (r - l) * f;
                g = l + (g - l) * f;
                b = l + (b - l) * f;
            }
            if (mono) {
                r += (l - r) * mono;
                g += (l - g) * mono;
                b += (l - b) * mono;
            }
            if (split) {
                const t = smoothstep(0.1, 0.9, l);
                const a = split.amount;
                r += a * ((1 - t) * split.shadows[0] + t * split.highlights[0]);
                g += a * ((1 - t) * split.shadows[1] + t * split.highlights[1]);
                b += a * ((1 - t) * split.shadows[2] + t * split.highlights[2]);
            }
            data[j] = r;
            data[j + 1] = g;
            data[j + 2] = b;
        }
    }

    if (adv) {
        applyLevelsCurves(img, adv);
        applyColour(img, adv);
    }

    // 6. Tools that need masks (sky, colour focus, portrait light, blur)
    if (tools) tools(img, recipe, masks);

    // 7. Vignette
    if (adjust.vignette) {
        const amount = adjust.vignette * CAL.vignette;
        const cx = width / 2;
        const cy = height / 2;
        for (let y = 0; y < height; y++) {
            const dy = (y + 0.5 - cy) / cy;
            for (let x = 0; x < width; x++) {
                const dx = (x + 0.5 - cx) / cx;
                const r = Math.sqrt((dx * dx + dy * dy) / 2);
                const k = 1 - amount * smoothstep(0.35, 1.05, r);
                const j = (y * width + x) * 3;
                data[j] *= k;
                data[j + 1] *= k;
                data[j + 2] *= k;
            }
        }
    }

    if (adv) applyFinish(img, adv, helpers);

    for (let j = 0; j < data.length; j++) {
        const v = data[j];
        data[j] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    return img;
}

function hueOf(r, g, b, max, chroma) {
    let h;
    if (max === r) h = ((g - b) / chroma) % 6;
    else if (max === g) h = (b - r) / chroma + 2;
    else h = (r - g) / chroma + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
}

function bandWeight(hue, centre, halfWidth) {
    let d = Math.abs(hue - centre);
    if (d > 180) d = 360 - d;
    return d >= halfWidth ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / halfWidth);
}

// Resamples masks (upright source orientation, any resolution) into the output's
// geometry, and maps face boxes the same way
export function transformMasks(masks, geometry, W0, H0, outW, outH) {
    if (!masks) return null;
    const map = outputMapping(geometry, W0, H0, outW, outH);
    const p = [0, 0];
    const out = { width: outW, height: outH };
    for (const key of ['sky', 'subject', 'depth']) {
        const src = masks[key];
        if (!src) continue;
        const mw = masks.width;
        const mh = masks.height;
        const dst = new Float32Array(outW * outH);
        for (let v = 0; v < outH; v++) {
            for (let u = 0; u < outW; u++) {
                map(u, v, p);
                const x = Math.min(mw - 1, Math.max(0, (p[0] / W0) * mw - 0.5));
                const y = Math.min(mh - 1, Math.max(0, (p[1] / H0) * mh - 0.5));
                const x0 = Math.floor(x), y0 = Math.floor(y);
                const x1 = Math.min(mw - 1, x0 + 1), y1 = Math.min(mh - 1, y0 + 1);
                const ax = x - x0, ay = y - y0;
                const top = src[y0 * mw + x0] + (src[y0 * mw + x1] - src[y0 * mw + x0]) * ax;
                const bottom = src[y1 * mw + x0] + (src[y1 * mw + x1] - src[y1 * mw + x0]) * ax;
                dst[v * outW + u] = top + (bottom - top) * ay;
            }
        }
        out[key] = dst;
    }
    if (masks.faces?.length) {
        // The mapping is affine: invert it from three points to move face boxes forward
        const o = map(0, 0, [0, 0]);
        const ex = map(1, 0, [0, 0]);
        const ey = map(0, 1, [0, 0]);
        const a = ex[0] - o[0], b = ey[0] - o[0], c = ex[1] - o[1], d = ey[1] - o[1];
        const det = a * d - b * c || 1;
        const forward = (x, y) => {
            const dx = x - o[0], dy = y - o[1];
            return [(d * dx - b * dy) / det, (-c * dx + a * dy) / det];
        };
        const scale = Math.sqrt(Math.abs(det)) || 1;
        out.faces = masks.faces.map((f) => {
            const [cx, cy] = forward((f.x + f.w / 2) * W0, (f.y + f.h / 2) * H0);
            const size = Math.max(f.w * W0, f.h * H0) / scale;
            return { x: cx / outW - size / 2 / outW, y: cy / outH - size / 2 / outH, w: size / outW, h: size / outH, score: f.score };
        }).filter(f => f.x + f.w > 0 && f.y + f.h > 0 && f.x < 1 && f.y < 1);
    }
    return out;
}

// Full render: geometry first (so tone work only touches kept pixels), then tone
export function render(src, recipe, { maxPixels = Infinity, sourceSize = null, masks = null, tools = null } = {}) {
    const r = normalizeRecipe(recipe);
    const geometric = applyGeometry(src, r.geometry, sourceSize, maxPixels);
    const W0 = sourceSize?.width ?? src.width;
    const H0 = sourceSize?.height ?? src.height;
    const moved = masks && tools ? transformMasks(masks, r.geometry, W0, H0, geometric.width, geometric.height) : null;
    return applyTone(geometric, r, { masks: moved, tools });
}
