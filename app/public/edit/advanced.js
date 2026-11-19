// Lightroom-style "Advanced" adjustments: exposure, clarity, dehaze, levels, curves,
// HSL per colour band, colour grading, sharpening, noise reduction, grain and a shaped
// vignette. Pure functions on the pipeline's Float32 RGB images; blur/luminance helpers
// are passed in to avoid a circular import with pipeline.js.

export const HSL_BANDS = [['red', 0], ['orange', 30], ['yellow', 60], ['green', 120], ['aqua', 180], ['blue', 220], ['purple', 270], ['magenta', 315]];
export const CURVE_CHANNELS = ['rgb', 'r', 'g', 'b'];
export const GRADING_REGIONS = ['shadows', 'midtones', 'highlights'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : 0));
const r3 = v => Math.round(v * 1000) / 1000;

export function defaultAdvanced() {
    return {
        exposure: 0, clarity: 0, dehaze: 0,
        levels: { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 },
        curves: { rgb: [], r: [], g: [], b: [] },
        hsl: Object.fromEntries(HSL_BANDS.map(([name]) => [name, { h: 0, s: 0, l: 0 }])),
        grading: { shadows: { hue: 200, sat: 0 }, midtones: { hue: 30, sat: 0 }, highlights: { hue: 40, sat: 0 }, balance: 0, blending: 0.5 },
        sharpen: { amount: 0, radius: 1 },
        noise: 0,
        grain: 0,
        vignette: { amount: 0, midpoint: 0.5, roundness: 0, feather: 0.5 },
    };
}

export function normalizeAdvanced(a = {}) {
    const d = defaultAdvanced();
    const x = a && typeof a === 'object' ? a : {};
    const points = list => (Array.isArray(list) ? list : []).slice(0, 16)
        .map(p => [r3(clamp(p?.[0], 0, 1)), r3(clamp(p?.[1], 0, 1))])
        .sort((p, q) => p[0] - q[0])
        .filter((p, i, all) => i === 0 || p[0] - all[i - 1][0] > 0.005);
    const lv = x.levels ?? {};
    const out = {
        exposure: r3(clamp(x.exposure ?? 0, -3, 3)),
        clarity: r3(clamp(x.clarity ?? 0, -1, 1)),
        dehaze: r3(clamp(x.dehaze ?? 0, -1, 1)),
        levels: {
            inBlack: r3(clamp(lv.inBlack ?? 0, 0, 0.5)), inWhite: r3(clamp(lv.inWhite ?? 1, 0.5, 1)),
            gamma: r3(clamp(lv.gamma ?? 1, 0.2, 5)),
            outBlack: r3(clamp(lv.outBlack ?? 0, 0, 0.5)), outWhite: r3(clamp(lv.outWhite ?? 1, 0.5, 1)),
        },
        curves: Object.fromEntries(CURVE_CHANNELS.map(c => [c, points(x.curves?.[c])])),
        hsl: Object.fromEntries(HSL_BANDS.map(([name]) => {
            const b = x.hsl?.[name] ?? {};
            return [name, { h: r3(clamp(b.h ?? 0, -1, 1)), s: r3(clamp(b.s ?? 0, -1, 1)), l: r3(clamp(b.l ?? 0, -1, 1)) }];
        })),
        grading: {
            ...Object.fromEntries(GRADING_REGIONS.map(r => [r, {
                hue: Math.round(clamp(x.grading?.[r]?.hue ?? d.grading[r].hue, 0, 360)),
                sat: r3(clamp(x.grading?.[r]?.sat ?? 0, 0, 1)),
            }])),
            balance: r3(clamp(x.grading?.balance ?? 0, -1, 1)),
            blending: r3(clamp(x.grading?.blending ?? 0.5, 0, 1)),
        },
        sharpen: { amount: r3(clamp(x.sharpen?.amount ?? 0, 0, 1)), radius: r3(clamp(x.sharpen?.radius ?? 1, 0.5, 3)) },
        noise: r3(clamp(x.noise ?? 0, 0, 1)),
        grain: r3(clamp(x.grain ?? 0, 0, 1)),
        vignette: {
            amount: r3(clamp(x.vignette?.amount ?? 0, -1, 1)), midpoint: r3(clamp(x.vignette?.midpoint ?? 0.5, 0, 1)),
            roundness: r3(clamp(x.vignette?.roundness ?? 0, -1, 1)), feather: r3(clamp(x.vignette?.feather ?? 0.5, 0, 1)),
        },
    };
    return out;
}

export function isAdvancedIdentity(a) {
    const n = normalizeAdvanced(a);
    const lv = n.levels;
    return !n.exposure && !n.clarity && !n.dehaze
        && lv.inBlack === 0 && lv.inWhite === 1 && lv.gamma === 1 && lv.outBlack === 0 && lv.outWhite === 1
        && CURVE_CHANNELS.every(c => !n.curves[c].length)
        && HSL_BANDS.every(([b]) => !n.hsl[b].h && !n.hsl[b].s && !n.hsl[b].l)
        && GRADING_REGIONS.every(r => !n.grading[r].sat)
        && !n.sharpen.amount && !n.noise && !n.grain && !n.vignette.amount;
}

// Monotone cubic (Fritsch–Carlson) through the points plus the corners, as a 1024-entry LUT
export function curveLut(points) {
    const pts = [[0, 0], ...points.filter(p => p[0] > 0.005 && p[0] < 0.995), [1, 1]];
    for (const p of points) {
        if (p[0] <= 0.005) pts[0] = [0, p[1]];
        if (p[0] >= 0.995) pts[pts.length - 1] = [1, p[1]];
    }
    const n = pts.length;
    const dx = [], dy = [], m = [];
    for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0]); dy.push((pts[i + 1][1] - pts[i][1]) / dx[i]); }
    const t = new Array(n);
    t[0] = dy[0]; t[n - 1] = dy[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = dy[i - 1] * dy[i] <= 0 ? 0 : (dy[i - 1] + dy[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
        if (dy[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
        const a = t[i] / dy[i], b = t[i + 1] / dy[i], s = a * a + b * b;
        if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * dy[i]; t[i + 1] = k * b * dy[i]; }
    }
    const lut = new Float32Array(1025);
    let seg = 0;
    for (let k = 0; k <= 1024; k++) {
        const x = k / 1024;
        while (seg < n - 2 && x > pts[seg + 1][0]) seg++;
        const h = dx[seg], u = (x - pts[seg][0]) / h;
        const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
        lut[k] = Math.min(1, Math.max(0, h00 * pts[seg][1] + h10 * h * t[seg] + h01 * pts[seg + 1][1] + h11 * h * t[seg + 1]));
    }
    return lut;
}

const lookup = (lut, v) => {
    const f = Math.min(1, Math.max(0, v)) * 1024;
    const i = Math.floor(f);
    return i >= 1024 ? lut[1024] : lut[i] + (lut[i + 1] - lut[i]) * (f - i);
};

// Exposure in EV, before everything else (linear gain expressed in gamma space)
export function applyExposure(img, a) {
    if (!a.exposure) return;
    const k = Math.pow(2, a.exposure / 2.2);
    for (let j = 0; j < img.data.length; j++) img.data[j] *= k;
}

// Clarity (large-radius local contrast on midtones) and dehaze (dark-channel veil removal)
export function applyClarityDehaze(img, a, { blurChannel, luminance }) {
    const { width, height, data } = img;
    const n = width * height;
    const diag = Math.hypot(width, height);
    if (a.clarity) {
        const L = luminance(img);
        const B = blurChannel(L, width, height, diag * 0.02);
        for (let p = 0, j = 0; p < n; p++, j += 3) {
            const mid = 1 - Math.abs(2 * L[p] - 1);
            const d = (L[p] - B[p]) * a.clarity * 1.6 * mid;
            data[j] += d; data[j + 1] += d; data[j + 2] += d;
        }
    }
    if (a.dehaze) {
        const dark = new Float32Array(n);
        for (let p = 0, j = 0; p < n; p++, j += 3) dark[p] = Math.min(data[j], data[j + 1], data[j + 2]);
        const veil = blurChannel(dark, width, height, diag * 0.015);
        const air = 0.95;
        const k = a.dehaze * 0.85;
        for (let p = 0, j = 0; p < n; p++, j += 3) {
            const t = Math.max(0.15, 1 - k * veil[p]);
            for (let c = 0; c < 3; c++) data[j + c] = k >= 0 ? (data[j + c] - air * (1 - t)) / t : data[j + c] * (1 + k * 0.5) - k * 0.5 * air * veil[p];
        }
    }
}

// Levels and curves as per-channel LUTs
export function applyLevelsCurves(img, a) {
    const lv = a.levels;
    const levelsActive = lv.inBlack !== 0 || lv.inWhite !== 1 || lv.gamma !== 1 || lv.outBlack !== 0 || lv.outWhite !== 1;
    const curvesActive = CURVE_CHANNELS.some(c => a.curves[c].length);
    if (!levelsActive && !curvesActive) return;
    const master = a.curves.rgb.length ? curveLut(a.curves.rgb) : null;
    const per = ['r', 'g', 'b'].map(c => (a.curves[c].length ? curveLut(a.curves[c]) : null));
    const span = Math.max(1e-3, lv.inWhite - lv.inBlack);
    const level = v => lv.outBlack + (lv.outWhite - lv.outBlack) * Math.pow(Math.min(1, Math.max(0, (v - lv.inBlack) / span)), 1 / lv.gamma);
    const { data } = img;
    for (let j = 0; j < data.length; j++) {
        let v = levelsActive ? level(data[j]) : data[j];
        if (master) v = lookup(master, v);
        const c = per[j % 3];
        if (c) v = lookup(c, v);
        data[j] = v;
    }
}

function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
    if (!s) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
        t = ((t % 1) + 1) % 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const hh = h / 360;
    return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)];
}

// HSL per colour band and three-way colour grading
export function applyColour(img, a) {
    const hslActive = HSL_BANDS.some(([b]) => a.hsl[b].h || a.hsl[b].s || a.hsl[b].l);
    const gradingActive = GRADING_REGIONS.some(r => a.grading[r].sat);
    if (!hslActive && !gradingActive) return;
    const { data } = img;
    const bands = HSL_BANDS.map(([name, centre]) => ({ centre, ...a.hsl[name] }));
    const tints = GRADING_REGIONS.map((r) => {
        const { hue, sat } = a.grading[r];
        const [cr, cg, cb] = hslToRgb(hue, 1, 0.5);
        const lum = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
        return [(cr - lum) * sat * 0.18, (cg - lum) * sat * 0.18, (cb - lum) * sat * 0.18];
    });
    const bal = a.grading.balance * 0.25;
    const blend = 0.15 + a.grading.blending * 0.35;
    for (let j = 0; j < data.length; j += 3) {
        let r = data[j], g = data[j + 1], b = data[j + 2];
        if (hslActive) {
            let [h, s, l] = rgbToHsl(Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b)));
            let dh = 0, ds = 0, dl = 0, wsum = 0;
            for (const band of bands) {
                let d = Math.abs(h - band.centre);
                if (d > 180) d = 360 - d;
                const w = d >= 45 ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / 45);
                if (!w) continue;
                dh += band.h * w; ds += band.s * w; dl += band.l * w; wsum += w;
            }
            if (wsum) {
                const chroma = Math.min(1, s * 3);
                h = (h + dh * 30 + 360) % 360;
                s = Math.min(1, Math.max(0, s * (1 + ds)));
                l = Math.min(1, Math.max(0, l + dl * 0.25 * chroma));
                [r, g, b] = hslToRgb(h, s, l);
            }
        }
        if (gradingActive) {
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const shadow = Math.min(1, Math.max(0, (0.5 - bal - lum) / blend + 0.5));
            const highlight = Math.min(1, Math.max(0, (lum - 0.5 - bal) / blend + 0.5));
            const mid = Math.max(0, 1 - shadow - highlight);
            const w = [shadow, mid, highlight];
            for (let k = 0; k < 3; k++) {
                r += tints[k][0] * w[k]; g += tints[k][1] * w[k]; b += tints[k][2] * w[k];
            }
        }
        data[j] = r; data[j + 1] = g; data[j + 2] = b;
    }
}

// Detail and finishing: noise reduction, sharpening, shaped vignette, film grain
export function applyFinish(img, a, { blurChannel, luminance }) {
    const { width, height, data } = img;
    const n = width * height;
    const scale = Math.hypot(width, height) / 2500;
    if (a.noise) {
        const channels = [0, 1, 2].map(c => Float32Array.from({ length: n }, (_, p) => data[p * 3 + c]));
        const blurred = channels.map(ch => blurChannel(ch, width, height, Math.max(1, 1.5 * scale)));
        const L = luminance(img);
        const LB = blurChannel(L, width, height, Math.max(1, 1.5 * scale));
        for (let p = 0, j = 0; p < n; p++, j += 3) {
            // Keep edges: blend less where the pixel differs strongly from its surroundings
            const edge = Math.min(1, Math.abs(L[p] - LB[p]) * 12);
            const k = a.noise * (1 - edge) * 0.9;
            for (let c = 0; c < 3; c++) data[j + c] += (blurred[c][p] - data[j + c]) * k;
        }
    }
    if (a.sharpen.amount) {
        const L = luminance(img);
        const B = blurChannel(L, width, height, Math.max(1, a.sharpen.radius * scale));
        for (let p = 0, j = 0; p < n; p++, j += 3) {
            const d = (L[p] - B[p]) * a.sharpen.amount * 2;
            data[j] += d; data[j + 1] += d; data[j + 2] += d;
        }
    }
    const v = a.vignette;
    if (v.amount) {
        const cx = width / 2, cy = height / 2;
        const aspect = width / height;
        const round = (v.roundness + 1) / 2; // 0 = follows the frame, 1 = circle
        const inner = 0.2 + v.midpoint * 0.8;
        const soft = 0.05 + v.feather * 0.9;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let dx = (x + 0.5 - cx) / cx, dy = (y + 0.5 - cy) / cy;
                dx *= 1 + (aspect - 1) * round * (aspect > 1 ? 1 : 0);
                dy *= 1 + (1 / aspect - 1) * round * (aspect < 1 ? 1 : 0);
                const r = Math.hypot(dx, dy) / Math.SQRT2 * 1.2;
                const t = Math.min(1, Math.max(0, (r - inner + soft / 2) / soft));
                const w = t * t * (3 - 2 * t) * v.amount;
                const j = (y * width + x) * 3;
                for (let c = 0; c < 3; c++) data[j + c] = w > 0 ? data[j + c] * (1 - w * 0.8) : data[j + c] + (1 - data[j + c]) * -w * 0.8;
            }
        }
    }
    if (a.grain) {
        // Deterministic per-pixel noise, sized to the photo so preview and save match
        const size = Math.max(1, Math.round(scale * 1.5));
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const gx = Math.floor(x / size), gy = Math.floor(y / size);
                let h = (gx * 374761393 + gy * 668265263) | 0;
                h = Math.imul(h ^ (h >>> 13), 1274126177);
                const noise = (((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5) * a.grain * 0.12;
                const j = (y * width + x) * 3;
                data[j] += noise; data[j + 1] += noise; data[j + 2] += noise;
            }
        }
    }
}
