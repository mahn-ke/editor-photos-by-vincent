// Develops a Pixel DNG and fits a per-photo "baseline" that makes it look like the camera
// JPEG, so edits start from the JPEG look but keep the RAW's highlight headroom.
//
// 1. LibRaw (dcraw_emu) → 16-bit linear sRGB with camera white balance
// 2. Lens shading: the DNG's OpcodeList2 GainMaps, applied per channel
// 3. Lens distortion (OpcodeList3 WarpRectilinear), the camera's local tone map
//    (ProfileGainTableMap), then the EXIF orientation
// 4. Alignment: scale search (the JPEG may show less of the scene) plus phase correlation
// 5. Fit (on an area-averaged ~320 px image): per-channel monotone tone curves (extrapolated
//    above the JPEG's clipping point), a 3×3 colour matrix and a 16×12×8 local gain grid
// 6. Quality: median colour error; above the limit the JPEG is used instead

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
    const { stdout } = await run(EXIFTOOL, ['-j', '-n', '-b', '-OpcodeList2', '-OpcodeList3', '-ProfileGainTableMap', '-NoiseProfile',
        '-ColorMatrix1', '-ColorMatrix2', '-CameraCalibration1', '-CameraCalibration2', '-ForwardMatrix1', '-ForwardMatrix2',
        '-CalibrationIlluminant1', '-CalibrationIlluminant2', '-AsShotWhiteXY', '-AsShotNeutral', '-AnalogBalance', '-DefaultCropOrigin', '-DefaultCropSize', '-BaselineExposure', '-ImageWidth', '-ImageHeight', '-Model', '-Orientation', file], { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout)[0] ?? {};
}

// -4: 16-bit linear, no auto-brightening; -q 3: AHD. `camera`: raw camera channels with unit
// white balance (-o 0 -r 1 1 1 1), so the DNG's NoiseProfile describes the noise exactly;
// otherwise sRGB primaries with camera white balance
export async function develop(file, { camera = false } = {}) {
    const colour = camera ? ['-o', '0', '-r', '1', '1', '1', '1'] : ['-o', '1', '-w'];
    const { stdout } = await run(DCRAW, ['-T', '-4', ...colour, '-q', '3', '-t', '0', '-Z', '-', file], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
    // rgb16 keeps all 16 bits; without it sharp reduces the TIFF to 8 bits per channel
    const { data, info } = await sharp(stdout).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
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

// DNG opcode WarpRectilinear (id 1, in OpcodeList3): the lens distortion correction the camera
// applies (strong on the ultra-wide). Returns per-plane { kr[4], kt[2], cx, cy } (first plane used).
export function parseWarp(base64) {
    if (!base64) return null;
    const buf = Buffer.from(String(base64).replace(/^base64:/, ''), 'base64');
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 0;
    const count = view.getUint32(o); o += 4;
    let warp = null;
    for (let i = 0; i < count && o + 16 <= buf.length; i++) {
        const id = view.getUint32(o); o += 12;
        const size = view.getUint32(o); o += 4;
        if (id === 1) {
            let q = o + 4; // planes
            const d = () => { const v = view.getFloat64(q); q += 8; return v; };
            const kr = [d(), d(), d(), d()], kt = [d(), d()];
            // centre follows all planes; with one plane it comes right after
            const planes = view.getUint32(o);
            q = o + 4 + planes * 48;
            warp = { kr, kt, cx: d(), cy: d() };
        }
        o += size;
    }
    return warp;
}

// Applies WarpRectilinear: each output pixel samples the source at the distorted position
export function applyWarp(img, warp) {
    if (!warp) return img;
    const { width: w, height: h, data } = img;
    const cx = warp.cx * (w - 1), cy = warp.cy * (h - 1);
    const m = Math.max(Math.hypot(cx, cy), Math.hypot(w - 1 - cx, cy), Math.hypot(cx, h - 1 - cy), Math.hypot(w - 1 - cx, h - 1 - cy));
    const [k0, k1, k2, k3] = warp.kr, [t0, t1] = warp.kt;
    // Interpolating softens the whole image: skip warps that move no pixel by half a pixel
    let shift = 0;
    for (let r = 0; r <= 1.0001; r += 0.05) {
        const r2 = r * r;
        shift = Math.max(shift, Math.abs((k0 + r2 * (k1 + r2 * (k2 + r2 * k3)) - 1) * r * m) + (Math.abs(t0) + Math.abs(t1)) * 3 * r2 * m);
    }
    if (shift < 0.5) return img;
    const out = new Float32Array(data.length);
    for (let y = 0; y < h; y++) {
        const dy = (y - cy) / m;
        for (let x = 0; x < w; x++) {
            const dx = (x - cx) / m;
            const r2 = dx * dx + dy * dy;
            const f = k0 + r2 * (k1 + r2 * (k2 + r2 * k3));
            const sx = cx + m * (f * dx + 2 * t0 * dx * dy + t1 * (r2 + 2 * dx * dx));
            const sy = cy + m * (f * dy + 2 * t1 * dx * dy + t0 * (r2 + 2 * dy * dy));
            if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
            const x0 = Math.floor(sx), y0 = Math.floor(sy);
            const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
            const ax = sx - x0, ay = sy - y0;
            const d = (y * w + x) * 3;
            for (let c = 0; c < 3; c++) {
                const a = data[(y0 * w + x0) * 3 + c], b = data[(y0 * w + x1) * 3 + c];
                const e = data[(y1 * w + x0) * 3 + c], g = data[(y1 * w + x1) * 3 + c];
                out[d + c] = (a + (b - a) * ax) * (1 - ay) + (e + (g - e) * ax) * ay;
            }
        }
    }
    return { width: w, height: h, data: out };
}

// ProfileGainTableMap (DNG 1.6): the camera's local tone mapping. A grid of gain curves over
// the image (sensor orientation); each pixel's curve is indexed by a weighted mix of
// R, G, B, min and max. Stored in the file's byte order (little-endian on Pixels).
export function parseGainTable(base64) {
    if (!base64) return null;
    const buf = Buffer.from(String(base64).replace(/^base64:/, ''), 'base64');
    if (buf.length < 64) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const le = view.getUint32(0, true) < 65536;
    const u32 = o => view.getUint32(o, le), f64 = o => view.getFloat64(o, le), f32 = o => view.getFloat32(o, le);
    const pointsV = u32(0), pointsH = u32(4), points = u32(40);
    if (buf.length < 64 + pointsV * pointsH * points * 4) return null;
    const gains = new Float32Array(pointsV * pointsH * points);
    for (let i = 0; i < gains.length; i++) gains[i] = f32(64 + i * 4);
    return {
        pointsV, pointsH, spacingV: f64(8), spacingH: f64(16), originV: f64(24), originH: f64(32), points,
        weights: [0, 1, 2, 3, 4].map(i => f32(44 + i * 4)), gains,
    };
}

// Modifies `img` in place
export function applyGainTable(img, table, { inputScale = 1 } = {}) {
    if (!table) return img;
    const { width: w, height: h, data } = img;
    const { pointsV, pointsH, points, weights: [wr, wg, wb, wmin, wmax], gains } = table;
    const out = data; // in place: a 12 MP float image is ~150 MB
    for (let y = 0; y < h; y++) {
        const gy = Math.min(pointsV - 1, Math.max(0, ((y + 0.5) / h - table.originV) / table.spacingV));
        const y0 = Math.min(pointsV - 2, Math.floor(gy)), ay = gy - y0;
        for (let x = 0; x < w; x++) {
            const gx = Math.min(pointsH - 1, Math.max(0, ((x + 0.5) / w - table.originH) / table.spacingH));
            const x0 = Math.min(pointsH - 2, Math.floor(gx)), ax = gx - x0;
            const j = (y * w + x) * 3;
            const r = data[j], g = data[j + 1], b = data[j + 2];
            const mix = (wr * r + wg * g + wb * b + wmin * Math.min(r, g, b) + wmax * Math.max(r, g, b)) * inputScale;
            const t = Math.min(1, Math.max(0, mix)) * (points - 1);
            const t0 = Math.min(points - 2, Math.floor(t)), at = t - t0;
            const cell = (yy, xx) => {
                const o = (yy * pointsH + xx) * points + t0;
                return gains[o] + (gains[o + 1] - gains[o]) * at;
            };
            const top = cell(y0, x0) + (cell(y0, x0 + 1) - cell(y0, x0)) * ax;
            const bottom = cell(y0 + 1, x0) + (cell(y0 + 1, x0 + 1) - cell(y0 + 1, x0)) * ax;
            const k = top + (bottom - top) * ay;
            out[j] = r * k; out[j + 1] = g * k; out[j + 2] = b * k;
        }
    }
    return { width: w, height: h, data: out };
}

// EXIF orientation of the DNG (sensor data is developed unrotated, -t 0, so the sensor-space
// gain maps line up): 3 = 180°, 6 = 90° clockwise, 8 = 90° counter-clockwise
export function orient(img, orientation) {
    const o = Number(orientation) || 1;
    if (![3, 6, 8].includes(o)) return img;
    const { width: w, height: h, data } = img;
    const ow = o === 3 ? w : h, oh = o === 3 ? h : w;
    const out = new Float32Array(data.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let nx, ny;
            if (o === 3) { nx = w - 1 - x; ny = h - 1 - y; }
            else if (o === 6) { nx = h - 1 - y; ny = x; }
            else { nx = y; ny = w - 1 - x; }
            const s = (y * w + x) * 3, d = (ny * ow + nx) * 3;
            out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2];
        }
    }
    return { width: ow, height: oh, data: out };
}

// Wavelet thresholds in noise σ (luma, chroma); RAW_DENOISE="luma,chroma" overrides, "0" turns it off
const DENOISE = (() => {
    const v = process.env.RAW_DENOISE;
    if (v === '0') return null;
    const [luma, chroma] = v ? v.split(',').map(Number) : [];
    // Measured on eight Pixel pairs: noise at or below the camera JPEG's, detail ≈ 0.8–1.1×
    return { luma: Number.isFinite(luma) ? luma : 2.5, chroma: Number.isFinite(chroma) ? chroma : 4 };
})();

// Developed, denoised, lens-shading corrected and upright linear sRGB, ready to align
export async function prepareSource(file, { noise = DENOISE } = {}) {
    const tags = await readTags(file);
    const toSrgb = cameraToSrgb(tags);
    const dev = await develop(file, { camera: Boolean(toSrgb) });
    // Raw camera channels: denoise with the exact noise model, then lens shading per channel,
    // then white balance and colour
    if (toSrgb && noise) denoise(dev, parseNoiseProfile(tags.NoiseProfile), noise);
    const shaded = applyMatrix(applyGainMaps(dev, parseGainMaps(tags.OpcodeList2)), toSrgb);
    const warped = applyWarp(shaded, parseWarp(tags.OpcodeList3));
    // The table is indexed by the pixel before baseline exposure (measured: lower error than after)
    const toned = applyGainTable(warped, parseGainTable(tags.ProfileGainTableMap));
    return orient(toned, tags.Orientation);
}

// Crops the developed image to the region that matches the JPEG frame
export function cropForBaseline(dev, a) {
    const x0 = Math.max(0, Math.round(a.dx * dev.width));
    const y0 = Math.max(0, Math.round(a.dy * dev.height));
    // The JPEG frame covers `scale` of the developed image (less when the camera crops)
    const w = Math.min(dev.width - x0, Math.round(dev.width * a.scale));
    const h = Math.min(dev.height - y0, Math.round(dev.height * a.scale));
    if (x0 === 0 && y0 === 0 && w === dev.width && h === dev.height) return dev;
    const out = { width: w, height: h, data: new Float32Array(w * h * 3) };
    for (let y = 0; y < h; y++) out.data.set(dev.data.subarray(((y0 + y) * dev.width + x0) * 3, ((y0 + y) * dev.width + x0 + w) * 3), y * w * 3);
    return out;
}

// ---- Colour (DNG spec: camera neutral and ForwardMatrix) -----------------------------

const nums = v => String(v ?? '').trim().split(/\s+/).map(Number).filter(Number.isFinite);
const mat3 = v => { const a = nums(v); return a.length === 9 ? [a.slice(0, 3), a.slice(3, 6), a.slice(6, 9)] : null; };
const mul3 = (a, b) => a.map(r => [0, 1, 2].map(j => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
const mulv = (a, v) => a.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const mix3 = (a, b, w) => a.map((r, i) => r.map((v, j) => v * w + b[i][j] * (1 - w)));
// EXIF LightSource codes → colour temperature (K)
const ILLUMINANT_K = { 1: 5500, 2: 4200, 3: 2850, 4: 5500, 10: 6500, 11: 7500, 12: 6400, 13: 5000, 14: 4200, 15: 3450, 17: 2856, 18: 4874, 19: 6774, 20: 5503, 21: 6504, 22: 7504, 23: 5003, 24: 3200 };
// XYZ (D50) → linear sRGB (D65), Bradford-adapted
const XYZ50_TO_SRGB = [[3.1338561, -1.6168667, -0.4906146], [-0.9787684, 1.9161415, 0.0334540], [0.0719453, -0.2289914, 1.4052427]];

// Camera RGB (unit white balance) → linear sRGB: white balance from AsShotWhiteXY (or
// AsShotNeutral), ColorMatrix/ForwardMatrix interpolated by colour temperature
export function cameraToSrgb(tags) {
    const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const cc1 = mat3(tags.CameraCalibration1) ?? identity;
    const cc2 = mat3(tags.CameraCalibration2) ?? cc1;
    const cm1 = mat3(tags.ColorMatrix1), cm2 = mat3(tags.ColorMatrix2) ?? cm1;
    const fm1 = mat3(tags.ForwardMatrix1), fm2 = mat3(tags.ForwardMatrix2) ?? fm1;
    if (!cm1 || !fm1) return null;
    const t1 = ILLUMINANT_K[Number(tags.CalibrationIlluminant1)] ?? 2856;
    const t2 = ILLUMINANT_K[Number(tags.CalibrationIlluminant2)] ?? 6504;
    const weight = cct => Math.min(1, Math.max(0, (1 / cct - 1 / t2) / (1 / t1 - 1 / t2)));
    let neutral = nums(tags.AsShotNeutral);
    let w = 0.5;
    if (neutral.length !== 3) {
        const [x, y] = nums(tags.AsShotWhiteXY);
        const xyz = x && y ? [x / y, 1, (1 - x - y) / y] : [0.9642, 1, 0.8249];
        const n = (x - 0.332) / (0.1858 - y); // McCamy
        w = weight(x && y ? 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33 : 5000);
        neutral = mulv(mix3(mul3(cc1, cm1), mul3(cc2, cm2), w), xyz);
    }
    const fm = mix3(fm1, fm2, w);
    const g = neutral[1];
    const balance = [[g / neutral[0], 0, 0], [0, 1, 0], [0, 0, g / neutral[2]]];
    return mul3(XYZ50_TO_SRGB, mul3(fm, balance));
}

export function applyMatrix(img, m) {
    if (!m) return img;
    const d = img.data;
    for (let j = 0; j < d.length; j += 3) {
        const r = d[j], g = d[j + 1], b = d[j + 2];
        d[j] = m[0][0] * r + m[0][1] * g + m[0][2] * b;
        d[j + 1] = m[1][0] * r + m[1][1] * g + m[1][2] * b;
        d[j + 2] = m[2][0] * r + m[2][1] * g + m[2][2] * b;
    }
    return img;
}

// ---- Noise reduction -----------------------------------------------------------------
// The DNG NoiseProfile gives, per colour plane, variance = S·x + O (x: 0..1 raw). The generalised
// Anscombe transform makes the noise unit-variance everywhere; an orthonormal luma/chroma split
// follows (chroma is denoised harder, as in HDR+'s published finishing pipeline), then each
// plane is decomposed with an à-trous B3-spline wavelet whose detail coefficients are
// soft-thresholded at k·σ of that scale. In place, on raw camera RGB (before lens shading).

const B3_SIGMA = [0.8908, 0.2007, 0.0856, 0.0413, 0.0205, 0.0103];

function mirror(i, n) {
    if (i < 0) i = -i;
    if (i >= n) i = 2 * n - 2 - i;
    return Math.min(n - 1, Math.max(0, i));
}

function atrousPass(src, dst, w, h, step, horizontal) {
    const k0 = 0.375, k1 = 0.25, k2 = 0.0625;
    if (horizontal) {
        for (let y = 0; y < h; y++) {
            const row = y * w;
            for (let x = 0; x < w; x++) {
                const inner = x >= 2 * step && x < w - 2 * step;
                const a = inner ? x - 2 * step : mirror(x - 2 * step, w), b = inner ? x - step : mirror(x - step, w);
                const c = inner ? x + step : mirror(x + step, w), d = inner ? x + 2 * step : mirror(x + 2 * step, w);
                dst[row + x] = k0 * src[row + x] + k1 * (src[row + b] + src[row + c]) + k2 * (src[row + a] + src[row + d]);
            }
        }
    } else {
        for (let y = 0; y < h; y++) {
            const a = mirror(y - 2 * step, h) * w, b = mirror(y - step, h) * w, c = mirror(y + step, h) * w, d = mirror(y + 2 * step, h) * w;
            const row = y * w;
            for (let x = 0; x < w; x++) {
                dst[row + x] = k0 * src[row + x] + k1 * (src[b + x] + src[c + x]) + k2 * (src[a + x] + src[d + x]);
            }
        }
    }
}

// Soft-thresholds the wavelet detail of `plane` in place; thresholds[k] for scale k (2^k px)
export function waveletShrink(plane, w, h, thresholds) {
    let current = Float32Array.from(plane);
    let next = new Float32Array(plane.length);
    const tmp = new Float32Array(plane.length);
    plane.fill(0);
    for (let k = 0; k < thresholds.length; k++) {
        atrousPass(current, tmp, w, h, 1 << k, true);
        atrousPass(tmp, next, w, h, 1 << k, false);
        const t = thresholds[k];
        for (let i = 0; i < plane.length; i++) {
            const d = current[i] - next[i];
            plane[i] += d > t ? d - t : d < -t ? d + t : 0;
        }
        [current, next] = [next, current];
    }
    for (let i = 0; i < plane.length; i++) plane[i] += current[i];
    return plane;
}

export function parseNoiseProfile(value) {
    const a = nums(value);
    if (a.length >= 6) return [[a[0], a[1]], [a[2], a[3]], [a[4], a[5]]];
    if (a.length >= 2) return [[a[0], a[1]], [a[0], a[1]], [a[0], a[1]]];
    return null;
}

const INV_SQRT3 = 1 / Math.sqrt(3), INV_SQRT2 = 1 / Math.SQRT2, INV_SQRT6 = 1 / Math.sqrt(6);

export function denoise(img, profile, { luma = 1, chroma = 3, scales = 5 } = {}) {
    if (!profile) return img;
    const { width: w, height: h, data } = img;
    const n = w * h;
    const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const [[S0, O0], [S1, O1], [S2, O2]] = profile;
    const gat = (x, S, O) => (2 / S) * Math.sqrt(Math.max(0, S * x + 0.375 * S * S + O));
    for (let p = 0, j = 0; p < n; p++, j += 3) {
        const r = gat(data[j], S0, O0), g = gat(data[j + 1], S1, O1), b = gat(data[j + 2], S2, O2);
        planes[0][p] = (r + g + b) * INV_SQRT3;
        planes[1][p] = (r - b) * INV_SQRT2;
        planes[2][p] = (r - 2 * g + b) * INV_SQRT6;
    }
    if (luma > 0) waveletShrink(planes[0], w, h, B3_SIGMA.slice(0, scales).map(s => s * luma));
    if (chroma > 0) {
        waveletShrink(planes[1], w, h, B3_SIGMA.slice(0, scales).map(s => s * chroma));
        waveletShrink(planes[2], w, h, B3_SIGMA.slice(0, scales).map(s => s * chroma));
    }
    const inv = (v, S, O) => { const half = v * S / 2; return Math.max(0, (half * half - 0.375 * S * S - O) / S); };
    for (let p = 0, j = 0; p < n; p++, j += 3) {
        const y = planes[0][p] * INV_SQRT3, c1 = planes[1][p] * INV_SQRT2, c2 = planes[2][p] * INV_SQRT6;
        data[j] = inv(y + c1 + c2, S0, O0);
        data[j + 1] = inv(y - 2 * c2, S1, O1);
        data[j + 2] = inv(y - c1 + c2, S2, O2);
    }
    return img;
}

// ---- Sharpening ----------------------------------------------------------------------
// Adds gains[k] × the luma detail of à-trous scale k (1, 2, 4 px) to every channel of the
// display-referred image; the gains are fitted per photo to the camera JPEG's detail

export function lumaBands(img, count) {
    const { width: w, height: h, data } = img;
    const n = w * h;
    let current = new Float32Array(n);
    for (let p = 0, j = 0; p < n; p++, j += 3) current[p] = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
    const tmp = new Float32Array(n);
    const bands = [];
    for (let k = 0; k < count; k++) {
        const next = new Float32Array(n);
        atrousPass(current, tmp, w, h, 1 << k, true);
        atrousPass(tmp, next, w, h, 1 << k, false);
        for (let i = 0; i < n; i++) current[i] -= next[i];
        bands.push(current);
        current = next;
    }
    return bands;
}

// Coring: only detail above `cores[k]` (the remaining noise of that scale) is amplified
const core = (v, t) => (v > t ? v - t : v < -t ? v + t : 0);

export function sharpen(img, gains, cores = []) {
    if (!gains?.some(g => Math.abs(g) > 0.01)) return img;
    const bands = lumaBands(img, gains.length);
    const d = img.data;
    const n = d.length / 3;
    for (let p = 0, j = 0; p < n; p++, j += 3) {
        let add = 0;
        for (let k = 0; k < gains.length; k++) add += gains[k] * core(bands[k][p], cores[k] ?? 0);
        d[j] += add; d[j + 1] += add; d[j + 2] += add;
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

// Area-average downscale by an integer factor: point samples of a noisy single RAW frame
// against the camera's denoised multi-frame JPEG would flatten every fitted curve
function boxShrink(img, k) {
    if (k <= 1) return img;
    const w = Math.floor(img.width / k), h = Math.floor(img.height / k);
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0;
            for (let yy = y * k; yy < y * k + k; yy++) {
                for (let xx = x * k; xx < x * k + k; xx++) {
                    const j = (yy * img.width + xx) * 3;
                    r += img.data[j]; g += img.data[j + 1]; b += img.data[j + 2];
                }
            }
            const d = (y * w + x) * 3, n = k * k;
            out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n;
        }
    }
    return { width: w, height: h, data: out };
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
        grid = next.map(v => (Number.isNaN(v) ? 0 : v));
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
// `inPlace` writes into `img` (saves a full-size copy when it is not needed any more)
export function applyBaseline(img, baseline, { exposure = 0, inPlace = false } = {}) {
    const { width, height, data } = img;
    const out = inPlace ? img : { width, height, data: new Float32Array(width * height * 3) };
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
export async function buildBaseline(source, jpegPixels, jpegWidth, jpegHeight, log = console) {
    const W = 320;
    const jw = W;
    const jh = Math.round((jpegHeight / jpegWidth) * W);
    const jpegSmall = await sharp(Buffer.from(jpegPixels.buffer), { raw: { width: jpegWidth, height: jpegHeight, channels: 3 } }).resize(jw, jh).raw().toBuffer();
    const jpeg = Float32Array.from(jpegSmall, v => v / 255);
    let dev = source;
    dev = boxShrink(dev, Math.max(1, Math.floor(dev.width / jw)));
    // Zoom shots store a crop: the DNG covers less of the scene than the JPEG frame implies
    const baseScale = dev.width / jw;
    // Normalise brightness for alignment: night shots are several stops darker than their JPEG
    const lumAll = luminanceOf(dev.data, dev.width * dev.height);
    const sample = [];
    for (let i = 0; i < lumAll.length; i += 97) sample.push(lumAll[i]);
    sample.sort((a, b) => a - b);
    const norm = 0.8 / Math.max(1e-4, sample[Math.floor(sample.length * 0.98)]);
    let best = null;
    const tryScale = (s) => {
        const scale = baseScale * s;
        const offX = (dev.width / scale - jw) / 2;
        const offY = (dev.height / scale - jh) / 2;
        const warped = warpInto(dev, scale, offX, offY, jw, jh);
        const a = luminanceOf(Float32Array.from(warped, v => Math.min(1, linearToSrgb(v * norm))), jw * jh);
        const b = luminanceOf(jpeg, jw * jh);
        const pc = phaseCorrelate(a, b, jw, jh, 512);
        if (!best || pc.confidence > best.confidence) best = { scale, s, offX: offX + pc.dx, offY: offY + pc.dy, confidence: pc.confidence };
    };
    // The JPEG may show less of the scene than the RAW (distortion correction, digital crop):
    // a coarse search over scale, then refinement around the best match
    for (const s of [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7]) tryScale(s);
    for (const step of [0.02, 0.008, 0.003]) {
        const centre = best.s;
        for (const d of [-2, -1, 1, 2]) tryScale(centre + d * step);
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

// ---- Matching the camera's detail ------------------------------------------------------
// Compares luma detail of our render and the camera JPEG (same framing and size, display-
// referred, e.g. a central 1024² region at full resolution) in 16×16 blocks. Blocks where the
// JPEG has the most detail at scale k fit that scale's gain (energy ratio); the flattest
// blocks show the remaining noise. Returns { gains, detail: [ours/jpeg per scale], noise }.
const SHARPEN_SCALES = 5;

function fitSharpenOnce(ours, jpeg, coring, fixedCores) {
    const { width: w, height: h } = ours;
    const bo = lumaBands(ours, SHARPEN_SCALES), bj = lumaBands(jpeg, SHARPEN_SCALES);
    const B = 16, bw = Math.floor(w / B), bh = Math.floor(h / B);
    const blocks = [];
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) blocks.push({ bx, by });
    const energy = (band, { bx, by }, f = v => v) => {
        let e = 0;
        for (let y = by * B; y < by * B + B; y++) for (let x = bx * B; x < bx * B + B; x++) e += f(band[y * w + x]) ** 2;
        return e / (B * B);
    };
    // Flattest blocks (by the JPEG's coarse detail): what we have there is noise
    const coarse = blocks.map(b => energy(bj[SHARPEN_SCALES - 1], b));
    const flat = blocks.map((b, i) => [b, coarse[i]]).sort((a, b) => a[1] - b[1]).slice(0, Math.max(1, Math.floor(blocks.length * 0.15))).map(([b]) => b);
    const rms = (band, set, f) => Math.sqrt(set.reduce((sum, b) => sum + energy(band, b, f), 0) / set.length);
    const gains = [], cores = [], detail = [];
    for (let k = 0; k < SHARPEN_SCALES; k++) {
        const t = fixedCores ? fixedCores[k] : coring * rms(bo[k], flat);
        cores.push(t);
        const top = blocks.map(b => [b, energy(bj[k], b)]).sort((a, b) => b[1] - a[1]).slice(0, Math.max(1, Math.floor(blocks.length * 0.3))).map(([b]) => b);
        const target = rms(bj[k], top);
        detail.push(Math.round((rms(bo[k], top) / Math.max(1e-9, target)) * 100) / 100);
        // Gain that brings the cored detail of the most detailed blocks to the JPEG's level
        let lo = -0.5, hi = 5;
        for (let iter = 0; iter < 30; iter++) {
            const g = (lo + hi) / 2;
            if (rms(bo[k], top, v => v + g * core(v, t)) < target) lo = g; else hi = g;
        }
        gains.push((lo + hi) / 2);
    }
    const noise = rms(bo[0], flat) / Math.max(1e-9, rms(bj[0], flat));
    return { gains, cores, detail, noise: Math.round(noise * 100) / 100 };
}

// Boosting a band and splitting the result again does not return the same band (the scales
// overlap), so the gains are refined by applying them and measuring again
export function fitSharpen(ours, jpeg, { coring = 3, iterations = 3 } = {}) {
    const first = fitSharpenOnce(ours, jpeg, coring);
    const cores = first.cores;
    let gains = first.gains;
    for (let i = 1; i < iterations; i++) {
        const trial = { width: ours.width, height: ours.height, data: Float32Array.from(ours.data) };
        sharpen(trial, gains, cores);
        const next = fitSharpenOnce(trial, jpeg, coring, cores.map(() => 0));
        gains = gains.map((g, k) => Math.min(6, Math.max(-0.6, (1 + g) * (1 + next.gains[k]) - 1)));
    }
    return {
        gains: gains.map(g => Math.round(g * 100) / 100),
        cores: cores.map(t => Math.round(t * 1e5) / 1e5),
        detail: first.detail,
        noise: first.noise,
    };
}

// A size×size region from the centre of `img`, sampled every `scale` pixels (nearest)
export function centreRegion(img, scale, size) {
    const out = new Float32Array(size * size * 3);
    const ox = img.width / 2 - (size / 2) * scale, oy = img.height / 2 - (size / 2) * scale;
    for (let y = 0; y < size; y++) {
        const sy = Math.min(img.height - 1, Math.max(0, Math.round(oy + y * scale)));
        for (let x = 0; x < size; x++) {
            const sx = Math.min(img.width - 1, Math.max(0, Math.round(ox + x * scale)));
            const s = (sy * img.width + sx) * 3, d = (y * size + x) * 3;
            out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2];
        }
    }
    return { width: size, height: size, data: out };
}

// Fits the sharpening of `crop` (developed, cropped to the JPEG's framing) to the camera
// JPEG at full resolution, on the central region; returns { gains, cores, detail, noise }
export async function fitDetail(crop, baseline, jpegFile) {
    const meta = await sharp(jpegFile).metadata();
    const swap = (meta.orientation ?? 1) >= 5;
    const jw = swap ? meta.height : meta.width, jh = swap ? meta.width : meta.height;
    const size = Math.min(1024, jw, jh);
    const { data } = await sharp(jpegFile).autoOrient()
        .extract({ left: Math.floor((jw - size) / 2), top: Math.floor((jh - size) / 2), width: size, height: size })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const cam = { width: size, height: size, data: Float32Array.from(data, v => v / 255) };
    const ours = applyBaseline(centreRegion(crop, crop.width / jw, size), baseline);
    return fitSharpen(ours, cam);
}
