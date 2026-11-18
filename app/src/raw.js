// Develops a Pixel DNG and fits a per-photo "baseline" that makes it look like the camera
// JPEG, so edits start from the JPEG look but keep the RAW's highlight headroom.
//
// 1. LibRaw (dcraw_emu) → 16-bit linear sRGB with camera white balance
// 2. Lens shading: the DNG's OpcodeList2 GainMaps, applied per channel
// 3. Alignment: scale from the image sizes (zoom shots store a crop), translation by
//    phase correlation on gradient images
// 4. Fit (at ~256 px): 3×3 colour matrix in linear light, per-channel monotone tone curves
//    (extrapolated above the JPEG's clipping point), and a 16×12 local luminance gain grid
// 5. Quality: median colour error; above the limit the editor falls back to the JPEG

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
const DCRAW = process.env.DCRAW_EMU || 'dcraw_emu';
const EXIFTOOL = process.env.EXIFTOOL || 'exiftool';
const GRID_W = 16;
const GRID_H = 12;
const KNOTS = 48;
export const MAX_DELTA_E = 6;

// ---- Reading the DNG -------------------------------------------------------------

export async function readTags(file) {
    const { stdout } = await run(EXIFTOOL, ['-j', '-n', '-b', '-OpcodeList2', '-DefaultCropOrigin', '-DefaultCropSize', '-BaselineExposure', '-ImageWidth', '-ImageHeight', '-Model', file], { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout)[0] ?? {};
}

export async function develop(file) {
    // -4: 16-bit linear, no auto-brightening; -o 1: sRGB primaries; -w: camera WB; -q 3: AHD
    const { stdout } = await run(DCRAW, ['-T', '-4', '-o', '1', '-w', '-q', '3', '-t', '0', '-Z', '-', file], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
    const { data, info } = await sharp(stdout).raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    const px = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    const lin = new Float32Array(info.width * info.height * 3);
    for (let p = 0, j = 0; p < info.width * info.height; p++, j += 3) {
        const o = p * info.channels;
        lin[j] = px[o] / 65535;
        lin[j + 1] = px[o + 1] / 65535;
        lin[j + 2] = px[o + 2] / 65535;
    }
    return { width: info.width, height: info.height, data: lin };
}

// DNG opcode lists are big-endian. GainMap (opcode 9): a smooth grid of gains per Bayer
// plane. After demosaicing we apply the R, mean(G1,G2) and B maps per channel.
export function parseGainMaps(base64) {
    if (!base64) return [];
    const buf = Buffer.from(String(base64).replace(/^base64:/, ''), 'base64');
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const maps = [];
    let o = 0;
    const count = view.getUint32(o); o += 4;
    for (let i = 0; i < count && o + 16 <= buf.length; i++) {
        const id = view.getUint32(o); o += 4;
        o += 8; // version, flags
        const size = view.getUint32(o); o += 4;
        if (id === 9) {
            let q = o;
            const r = () => { const v = view.getUint32(q); q += 4; return v; };
            const f64 = () => { const v = view.getFloat64(q); q += 8; return v; };
            const f32 = () => { const v = view.getFloat32(q); q += 4; return v; };
            const top = r(), left = r(), bottom = r(), right = r(), plane = r(), planes = r(), rowPitch = r(), colPitch = r();
            const pointsV = r(), pointsH = r();
            const spacingV = f64(), spacingH = f64(), originV = f64(), originH = f64();
            const mapPlanes = r();
            const gains = new Float32Array(pointsV * pointsH * mapPlanes);
            for (let k = 0; k < gains.length; k++) gains[k] = f32();
            maps.push({ top, left, bottom, right, plane, planes, rowPitch, colPitch, pointsV, pointsH, spacingV, spacingH, originV, originH, gains });
        }
        o += size;
    }
    return maps;
}

function gainAt(map, u, v) {
    // u, v: position in the active area, 0..1
    const gy = Math.min(map.pointsV - 1, Math.max(0, (v - map.originV) / map.spacingV));
    const gx = Math.min(map.pointsH - 1, Math.max(0, (u - map.originH) / map.spacingH));
    const y0 = Math.floor(gy), x0 = Math.floor(gx);
    const y1 = Math.min(map.pointsV - 1, y0 + 1), x1 = Math.min(map.pointsH - 1, x0 + 1);
    const ay = gy - y0, ax = gx - x0;
    const g = (y, x) => map.gains[y * map.pointsH + x];
    const top = g(y0, x0) + (g(y0, x1) - g(y0, x0)) * ax;
    const bottom = g(y1, x0) + (g(y1, x1) - g(y1, x0)) * ax;
    return top + (bottom - top) * ay;
}

export function applyGainMaps(img, maps) {
    if (maps.length < 3) return img;
    // Bayer RGGB: map order 0 = R, 1/2 = G, 3 = B (by their top/left offsets)
    const byPhase = [...maps].sort((a, b) => (a.top % 2) * 2 + (a.left % 2) - ((b.top % 2) * 2 + (b.left % 2)));
    const channelMaps = [[byPhase[0]], [byPhase[1], byPhase[2]].filter(Boolean), [byPhase[3] ?? byPhase.at(-1)]];
    const { width, height, data } = img;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const u = (x + 0.5) / width;
            const v = (y + 0.5) / height;
            const j = (y * width + x) * 3;
            for (let c = 0; c < 3; c++) {
                const list = channelMaps[c];
                const gain = list.reduce((s, m) => s + gainAt(m, u, v), 0) / list.length;
                data[j + c] *= gain;
            }
        }
    }
    return img;
}

// ---- Alignment ----------------------------------------------------------------------

const srgbToLinear = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const linearToSrgb = v => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);

function fft1d(re, im, invert) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (2 * Math.PI / len) * (invert ? -1 : 1);
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const ar = re[i + k], ai = im[i + k];
                const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
                const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
                re[i + k] = ar + br; im[i + k] = ai + bi;
                re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
                const nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
    }
}

function fft2d(re, im, n, invert) {
    const rr = new Float64Array(n), ri = new Float64Array(n);
    for (let y = 0; y < n; y++) {
        rr.set(re.subarray(y * n, y * n + n)); ri.set(im.subarray(y * n, y * n + n));
        fft1d(rr, ri, invert);
        re.set(rr, y * n); im.set(ri, y * n);
    }
    for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) { rr[y] = re[y * n + x]; ri[y] = im[y * n + x]; }
        fft1d(rr, ri, invert);
        for (let y = 0; y < n; y++) { re[y * n + x] = rr[y]; im[y * n + x] = ri[y]; }
    }
}

// Gradient magnitude of luminance on an n×n canvas (top-left aligned, zero padded)
function gradientCanvas(lum, w, h, n) {
    const out = new Float64Array(n * n);
    for (let y = 1; y < Math.min(h, n) - 1; y++) {
        for (let x = 1; x < Math.min(w, n) - 1; x++) {
            const gx = lum[y * w + x + 1] - lum[y * w + x - 1];
            const gy = lum[(y + 1) * w + x] - lum[(y - 1) * w + x];
            out[y * n + x] = Math.hypot(gx, gy);
        }
    }
    return out;
}

// Translation (dx, dy) such that b(x, y) ≈ a(x + dx, y + dy), and a confidence
export function phaseCorrelate(a, b, w, h, n = 256) {
    const ar = gradientCanvas(a, w, h, n), ai = new Float64Array(n * n);
    const br = gradientCanvas(b, w, h, n), bi = new Float64Array(n * n);
    fft2d(ar, ai, n, false);
    fft2d(br, bi, n, false);
    const cr = new Float64Array(n * n), ci = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) {
        const re = ar[i] * br[i] + ai[i] * bi[i];
        const im = ai[i] * br[i] - ar[i] * bi[i];
        const mag = Math.hypot(re, im) || 1;
        cr[i] = re / mag; ci[i] = im / mag;
    }
    fft2d(cr, ci, n, true);
    let best = 0;
    for (let i = 1; i < n * n; i++) if (cr[i] > cr[best]) best = i;
    let dy = Math.floor(best / n), dx = best % n;
    if (dx > n / 2) dx -= n;
    if (dy > n / 2) dy -= n;
    let sum = 0;
    for (let i = 0; i < n * n; i++) sum += Math.abs(cr[i]);
    return { dx, dy, confidence: cr[best] / (sum / (n * n)) / 50 };
}

function luminanceOf(data, n) {
    const L = new Float32Array(n);
    for (let p = 0, j = 0; p < n; p++, j += 3) L[p] = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
    return L;
}

// Resamples the developed image into the JPEG's frame given scale and offset
function warpInto(dev, scale, offX, offY, w, h) {
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const sx = Math.min(dev.width - 1, Math.max(0, (x + offX) * scale));
            const sy = Math.min(dev.height - 1, Math.max(0, (y + offY) * scale));
            const x0 = Math.floor(sx), y0 = Math.floor(sy);
            const x1 = Math.min(dev.width - 1, x0 + 1), y1 = Math.min(dev.height - 1, y0 + 1);
            const ax = sx - x0, ay = sy - y0;
            for (let c = 0; c < 3; c++) {
                const g = (yy, xx) => dev.data[(yy * dev.width + xx) * 3 + c];
                const top = g(y0, x0) + (g(y0, x1) - g(y0, x0)) * ax;
                const bottom = g(y1, x0) + (g(y1, x1) - g(y1, x0)) * ax;
                out[(y * w + x) * 3 + c] = top + (bottom - top) * ay;
            }
        }
    }
    return out;
}

// ---- Fitting -----------------------------------------------------------------------

function solve3(A, b) {
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c++) {
        let p = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        [M[c], M[p]] = [M[p], M[c]];
        for (let r = 0; r < 3; r++) {
            if (r === c) continue;
            const f = M[r][c] / (M[c][c] || 1e-12);
            for (let k = c; k <= 3; k++) M[r][k] -= f * M[c][k];
        }
    }
    return M.map((row, i) => row[3] / (row[i] || 1e-12));
}

// Pool-adjacent-violators: monotone non-decreasing fit
function isotonic(values, weights) {
    const blocks = [];
    values.forEach((v, i) => {
        blocks.push({ v, w: weights[i] || 1e-9, n: 1 });
        while (blocks.length > 1 && blocks.at(-2).v > blocks.at(-1).v) {
            const b = blocks.pop(), a = blocks.pop();
            blocks.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
        }
    });
    return blocks.flatMap(b => new Array(b.n).fill(b.v));
}

const LBINS = 8;

function knotFn(top) {
    const k = Math.log1p(top * 64);
    return v => Math.log1p(Math.max(0, v) * 64) / k;
}

function evalCurve(curve, f) {
    if (f >= KNOTS - 1) return curve[KNOTS - 1] + (f - (KNOTS - 1)) * Math.max(0.02, curve[KNOTS - 1] - curve[KNOTS - 2]);
    const i = Math.max(0, Math.floor(f));
    return curve[i] + (curve[Math.min(KNOTS - 1, i + 1)] - curve[i]) * (f - i);
}

function fitCurve(xs, ys, usable, n, c, knot) {
    const sums = new Float64Array(KNOTS), weights = new Float64Array(KNOTS);
    for (let p = 0; p < n; p++) {
        if (!usable[p]) continue;
        const k = Math.min(KNOTS - 1, Math.round(knot(xs[p * 3 + c]) * (KNOTS - 1)));
        sums[k] += ys[p * 3 + c];
        weights[k] += 1;
    }
    const raw = Array.from(sums, (s, k) => (weights[k] >= 3 ? s / weights[k] : null));
    const known = raw.map((v, k) => (v === null ? null : k)).filter(k => k !== null);
    const filled = raw.map((v, k) => {
        if (v !== null) return v;
        const lo = known.filter(i => i < k).at(-1);
        const hi = known.find(i => i > k);
        if (lo === undefined && hi === undefined) return k / (KNOTS - 1);
        if (lo === undefined) return raw[hi] * (k / hi);
        if (hi === undefined) return raw[lo] + (k - lo) * 0.02;
        return raw[lo] + ((raw[hi] - raw[lo]) * (k - lo)) / (hi - lo);
    });
    return isotonic(filled, Array.from(weights, w => Math.max(w, 0.5)));
}

// Bilateral grid: one log-gain per (x, y, brightness) cell, so the local tone mapping can
// treat shadows and highlights of the same area differently
function gridIndex(gx, gy, gl) {
    return (gy * GRID_W + gx) * LBINS + gl;
}

function sampleGrid(grid, x, y, l) {
    const gx = Math.min(GRID_W - 1, Math.max(0, x * GRID_W - 0.5));
    const gy = Math.min(GRID_H - 1, Math.max(0, y * GRID_H - 0.5));
    const gl = Math.min(LBINS - 1, Math.max(0, Math.sqrt(Math.max(0, Math.min(1.5, l)) / 1.5) * LBINS - 0.5));
    const x0 = Math.floor(gx), y0 = Math.floor(gy), l0 = Math.floor(gl);
    const x1 = Math.min(GRID_W - 1, x0 + 1), y1 = Math.min(GRID_H - 1, y0 + 1), l1 = Math.min(LBINS - 1, l0 + 1);
    const ax = gx - x0, ay = gy - y0, al = gl - l0;
    let v = 0;
    for (const [xx, wx] of [[x0, 1 - ax], [x1, ax]]) {
        for (const [yy, wy] of [[y0, 1 - ay], [y1, ay]]) {
            for (const [ll, wl] of [[l0, 1 - al], [l1, al]]) v += grid[gridIndex(xx, yy, ll)] * wx * wy * wl;
        }
    }
    return v;
}

export function fitBaseline(lin, jpeg, w, h) {
    const n = w * h;
    const L = luminanceOf(jpeg, n);
    const usable = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const p = y * w + x;
            const edge = Math.abs(L[p + 1] - L[p - 1]) + Math.abs(L[p + w] - L[p - w]);
            const j = p * 3;
            usable[p] = edge < 0.12 && Math.max(jpeg[j], jpeg[j + 1], jpeg[j + 2]) < 0.97 && L[p] > 0.015 ? 1 : 0;
        }
    }
    let top = 0;
    for (const v of lin) if (v > top) top = v;
    top = Math.max(1, top);
    const knot = knotFn(top);
    let grid = new Float32Array(GRID_W * GRID_H * LBINS);
    let curves = null;
    let matrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const model = (withLocal) => {
        const out = new Float32Array(n * 3);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = y * w + x, j = p * 3;
                const c0 = evalCurve(curves[0], knot(lin[j]) * (KNOTS - 1));
                const c1 = evalCurve(curves[1], knot(lin[j + 1]) * (KNOTS - 1));
                const c2 = evalCurve(curves[2], knot(lin[j + 2]) * (KNOTS - 1));
                let r = matrix[0][0] * c0 + matrix[0][1] * c1 + matrix[0][2] * c2;
                let g = matrix[1][0] * c0 + matrix[1][1] * c1 + matrix[1][2] * c2;
                let b = matrix[2][0] * c0 + matrix[2][1] * c1 + matrix[2][2] * c2;
                if (withLocal) {
                    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                    const k = Math.exp(sampleGrid(grid, (x + 0.5) / w, (y + 0.5) / h, l));
                    r *= k; g *= k; b *= k;
                }
                out[j] = r; out[j + 1] = g; out[j + 2] = b;
            }
        }
        return out;
    };
    for (let iter = 0; iter < 3; iter++) {
        // 1. Tone curves per channel, against the JPEG with the current local gain removed
        const target = new Float32Array(n * 3);
        if (iter === 0) target.set(jpeg);
        else {
            const pred = model(false);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const p = y * w + x, j = p * 3;
                    const l = 0.2126 * pred[j] + 0.7152 * pred[j + 1] + 0.0722 * pred[j + 2];
                    const k = Math.exp(-sampleGrid(grid, (x + 0.5) / w, (y + 0.5) / h, l));
                    for (let c = 0; c < 3; c++) target[j + c] = jpeg[j + c] * k;
                }
            }
        }
        // Invert the colour matrix's effect approximately by fitting curves first, matrix second
        curves = [0, 1, 2].map(c => fitCurve(lin, target, usable, n, c, knot));
        // 2. Colour matrix in display space (saturation and hue), ridge-regularised to identity
        const curved = new Float32Array(n * 3);
        for (let p = 0, j = 0; p < n; p++, j += 3) for (let c = 0; c < 3; c++) curved[j + c] = evalCurve(curves[c], knot(lin[j + c]) * (KNOTS - 1));
        const XtX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        const XtY = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        let count = 0;
        for (let p = 0; p < n; p++) {
            if (!usable[p]) continue;
            count++;
            const j = p * 3;
            for (let a = 0; a < 3; a++) {
                for (let b = 0; b < 3; b++) XtX[a][b] += curved[j + a] * curved[j + b];
                for (let c = 0; c < 3; c++) XtY[c][a] += curved[j + a] * target[j + c];
            }
        }
        const lambda = count * 0.002;
        for (let a = 0; a < 3; a++) {
            XtX[a][a] += lambda;
            for (let c = 0; c < 3; c++) XtY[c][a] += c === a ? lambda : 0;
        }
        matrix = [0, 1, 2].map(c => solve3(XtX, XtY[c]));
        // 3. Bilateral local gain from the remaining luminance ratio
        const pred = model(false);
        const sums = new Float64Array(grid.length), weights = new Float64Array(grid.length);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = y * w + x;
                if (!usable[p]) continue;
                const j = p * 3;
                const lp = 0.2126 * pred[j] + 0.7152 * pred[j + 1] + 0.0722 * pred[j + 2];
                if (lp < 0.02) continue;
                const gx = Math.min(GRID_W - 1, Math.floor(((x + 0.5) / w) * GRID_W));
                const gy = Math.min(GRID_H - 1, Math.floor(((y + 0.5) / h) * GRID_H));
                const gl = Math.min(LBINS - 1, Math.floor(Math.sqrt(Math.min(1.5, lp) / 1.5) * LBINS));
                const i = gridIndex(gx, gy, gl);
                sums[i] += Math.log(Math.max(1e-3, L[p]) / lp);
                weights[i] += 1;
            }
        }
        // Empty cells borrow from neighbours (spatial, then brightness), then smooth
        let next = Float32Array.from(sums, (s, i) => (weights[i] ? s / weights[i] : NaN));
        for (let pass = 0; pass < 6; pass++) {
            next = next.map((v, i) => {
                const gl = i % LBINS, cell = Math.floor(i / LBINS), gx = cell % GRID_W, gy = Math.floor(cell / GRID_W);
                let s = 0, ww = 0;
                for (const [dx, dy, dl, k] of [[0, 0, 0, 3], [1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]]) {
                    const x = gx + dx, y = gy + dy, l = gl + dl;
                    if (x < 0 || y < 0 || l < 0 || x >= GRID_W || y >= GRID_H || l >= LBINS) continue;
                    const u = next[gridIndex(x, y, l)];
                    if (Number.isNaN(u)) continue;
                    const conf = Math.min(1, weights[gridIndex(x, y, l)] / 20) + 0.2;
                    s += u * k * conf; ww += k * conf;
                }
                return ww ? s / ww : (Number.isNaN(v) ? NaN : v);
            });
        }
        // The bilateral grid still makes matches worse (see docs/raw.md); off unless RAW_LOCAL_GRID is set
        grid = process.env.RAW_LOCAL_GRID ? next.map(v => (Number.isNaN(v) ? 0 : v)) : new Float32Array(grid.length);
    }
    const baseline = {
        v: 2, top, curves: curves.map(c => c.map(v => Math.round(v * 10000) / 10000)), matrix: matrix.map(r => r.map(v => Math.round(v * 10000) / 10000)),
        grid: Array.from(grid, v => Math.round(v * 10000) / 10000), gridW: GRID_W, gridH: GRID_H, lbins: LBINS,
    };
    const result = applyBaseline({ width: w, height: h, data: lin }, baseline);
    const errors = [];
    for (let p = 0; p < n; p += 2) {
        if (!usable[p]) continue;
        const j = p * 3;
        errors.push(Math.hypot(result.data[j] - jpeg[j], result.data[j + 1] - jpeg[j + 1], result.data[j + 2] - jpeg[j + 2]) * 100);
    }
    errors.sort((a, b) => a - b);
    baseline.quality = { median: Math.round(errors[Math.floor(errors.length / 2)] * 100) / 100, p95: Math.round(errors[Math.floor(errors.length * 0.95)] * 100) / 100, samples: errors.length };
    return baseline;
}

// Linear developed RAW → sRGB-encoded image that matches the camera JPEG. Values above 1
// are kept (headroom) so the Highlights slider can recover them. `exposure` (EV) acts on
// the linear data first, like turning exposure up or down in a RAW converter.
export function applyBaseline(img, baseline, { exposure = 0 } = {}) {
    const { width, height, data } = img;
    const out = { width, height, data: new Float32Array(width * height * 3) };
    const { matrix, curves, grid, top } = baseline;
    const knot = knotFn(top);
    const gain = 2 ** exposure;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const j = (y * width + x) * 3;
            const c0 = evalCurve(curves[0], knot(data[j] * gain) * (KNOTS - 1));
            const c1 = evalCurve(curves[1], knot(data[j + 1] * gain) * (KNOTS - 1));
            const c2 = evalCurve(curves[2], knot(data[j + 2] * gain) * (KNOTS - 1));
            let r = matrix[0][0] * c0 + matrix[0][1] * c1 + matrix[0][2] * c2;
            let g = matrix[1][0] * c0 + matrix[1][1] * c1 + matrix[1][2] * c2;
            let b = matrix[2][0] * c0 + matrix[2][1] * c1 + matrix[2][2] * c2;
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const k = Math.exp(sampleGrid(grid, (x + 0.5) / width, (y + 0.5) / height, l));
            out.data[j] = Math.max(0, r * k);
            out.data[j + 1] = Math.max(0, g * k);
            out.data[j + 2] = Math.max(0, b * k);
        }
    }
    return out;
}

// Aligns a developed RAW to the JPEG preview and fits the baseline on ~256 px images
export async function buildBaseline(dev, jpegPixels, jpegWidth, jpegHeight, log = console) {
    const W = 320;
    const jw = W;
    const jh = Math.round((jpegHeight / jpegWidth) * W);
    const jpegSmall = await sharp(Buffer.from(jpegPixels.buffer), { raw: { width: jpegWidth, height: jpegHeight, channels: 3 } }).resize(jw, jh).raw().toBuffer();
    const jpeg = Float32Array.from(jpegSmall, v => v / 255);
    // Zoom shots store a crop: the DNG covers less of the scene than the JPEG frame implies
    const baseScale = dev.width / jw;
    let best = null;
    for (const s of [1, 0.985, 1.015, 0.97, 1.03]) {
        const scale = baseScale * s;
        const offX = (dev.width / scale - jw) / 2;
        const offY = (dev.height / scale - jh) / 2;
        const warped = warpInto(dev, scale, offX, offY, jw, jh);
        const a = luminanceOf(Float32Array.from(warped, v => Math.min(1, linearToSrgb(v * 2))), jw * jh);
        const b = luminanceOf(jpeg, jw * jh);
        const pc = phaseCorrelate(a, b, jw, jh, 512);
        if (!best || pc.confidence > best.confidence) best = { scale, offX: offX + pc.dx, offY: offY + pc.dy, confidence: pc.confidence };
    }
    const lin = warpInto(dev, best.scale, best.offX, best.offY, jw, jh);
    const baseline = fitBaseline(lin, jpeg, jw, jh);
    if (process.env.RAW_DEBUG) {
        const res = applyBaseline({ width: jw, height: jh, data: lin }, baseline).data;
        const n = jw * jh;
        const chan = [0, 0, 0], lumBins = new Array(5).fill(0).map(() => [0, 0]), region = new Array(9).fill(0).map(() => [0, 0]);
        let corrNum = 0, corrA = 0, corrB = 0;
        const la = luminanceOf(res, n), lb = luminanceOf(jpeg, n);
        const ma = la.reduce((a, b) => a + b, 0) / n, mb = lb.reduce((a, b) => a + b, 0) / n;
        for (let p = 0; p < n; p++) {
            const j = p * 3;
            for (let c = 0; c < 3; c++) chan[c] += (res[j + c] - jpeg[j + c]) / n;
            const e = Math.hypot(res[j] - jpeg[j], res[j + 1] - jpeg[j + 1], res[j + 2] - jpeg[j + 2]);
            const b = Math.min(4, Math.floor(lb[p] * 5));
            lumBins[b][0] += e; lumBins[b][1]++;
            const r = Math.min(2, Math.floor((p % jw) / jw * 3)) + 3 * Math.min(2, Math.floor(Math.floor(p / jw) / jh * 3));
            region[r][0] += e; region[r][1]++;
            corrNum += (la[p] - ma) * (lb[p] - mb); corrA += (la[p] - ma) ** 2; corrB += (lb[p] - mb) ** 2;
        }
        log.info?.(`RAW debug: dev ${dev.width}x${dev.height} jpeg ${jpegWidth}x${jpegHeight} bias ${chan.map(v => v.toFixed(3))} lumErr ${lumBins.map(([s, c]) => c ? (s / c * 100).toFixed(1) : '-').join('/')} region ${region.map(([s, c]) => (s / c * 100).toFixed(0)).join(',')} lumaCorr ${(corrNum / Math.sqrt(corrA * corrB)).toFixed(3)} align ${JSON.stringify(best)}`);
    }
    baseline.alignment = { scale: best.scale / baseScale, dx: best.offX * best.scale / dev.width, dy: best.offY * best.scale / dev.height, confidence: Math.round(best.confidence * 100) / 100 };
    log.info?.(`RAW baseline: median error ${baseline.quality.median}, p95 ${baseline.quality.p95}, alignment ${JSON.stringify(baseline.alignment)}`);
    return baseline;
}
