// Masks for the Tools tab, computed once per photo on the server and cached:
// depth (Depth Anything V2 Small), sky (U²-Net skyseg), subject matte (MODNet) and
// face boxes (YuNet; locations only, nothing about who it is).

import ort from 'onnxruntime-node';
import { resize } from '../../public/edit/pipeline.js';
import { ensureModel } from './models.js';

export const MASK_SIZE = 768;

function toChw(img, mean, std, bgr255 = false) {
    const { width: w, height: h, data } = img;
    const out = new Float32Array(3 * w * h);
    for (let p = 0, j = 0; p < w * h; p++, j += 3) {
        for (let c = 0; c < 3; c++) {
            const v = data[j + (bgr255 ? 2 - c : c)];
            out[c * w * h + p] = bgr255 ? v * 255 : (v - mean[c]) / std[c];
        }
    }
    return out;
}

const roundTo = (v, m) => Math.max(m, Math.round(v / m) * m);

function normalise(arr) {
    let min = Infinity, max = -Infinity;
    for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
    const span = max - min || 1;
    return Float32Array.from(arr, v => (v - min) / span);
}

// Single-channel bilinear resize
export function resizeChannel(src, sw, sh, dw, dh) {
    const out = new Float32Array(dw * dh);
    const fx = sw / dw;
    const fy = sh / dh;
    for (let y = 0; y < dh; y++) {
        const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
        const y0 = Math.floor(sy);
        const y1 = Math.min(sh - 1, y0 + 1);
        const ay = sy - y0;
        for (let x = 0; x < dw; x++) {
            const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
            const x0 = Math.floor(sx);
            const x1 = Math.min(sw - 1, x0 + 1);
            const ax = sx - x0;
            const top = src[y0 * sw + x0] + (src[y0 * sw + x1] - src[y0 * sw + x0]) * ax;
            const bottom = src[y1 * sw + x0] + (src[y1 * sw + x1] - src[y1 * sw + x0]) * ax;
            out[y * dw + x] = top + (bottom - top) * ay;
        }
    }
    return out;
}

function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a.w * a.h + b.w * b.h - inter);
}

export function createMasker({ modelDir, log = console }) {
    const sessions = {};
    const session = async (name) => {
        sessions[name] ??= ensureModel(name, modelDir, { log }).then(file => ort.InferenceSession.create(file, { intraOpNumThreads: 2 }));
        return sessions[name];
    };

    async function depth(img) {
        const s = await session('depth');
        const scale = 518 / Math.min(img.width, img.height);
        const w = roundTo(img.width * scale, 14);
        const h = roundTo(img.height * scale, 14);
        const input = resize(img, w, h);
        const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', toChw(input, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]), [1, 3, h, w]) });
        const t = out[s.outputNames[0]];
        const [oh, ow] = t.dims.slice(-2);
        return { data: normalise(t.data), width: ow, height: oh }; // 1 = near
    }

    async function sky(img) {
        const s = await session('sky');
        const input = resize(img, 320, 320);
        const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', toChw(input, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]), [1, 3, 320, 320]) });
        const t = out[s.outputNames[0]];
        let data = Float32Array.from(t.data);
        // Some exports return logits: squash to 0..1 if needed
        if (data.some(v => v < -0.01 || v > 1.01)) data = Float32Array.from(data, v => 1 / (1 + Math.exp(-v)));
        return { data, width: 320, height: 320 };
    }

    async function matte(img) {
        const s = await session('matte');
        const scale = 512 / Math.min(img.width, img.height);
        const w = roundTo(img.width * scale, 32);
        const h = roundTo(img.height * scale, 32);
        const input = resize(img, w, h);
        const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', toChw(input, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), [1, 3, h, w]) });
        const t = out[s.outputNames[0]];
        const [oh, ow] = t.dims.slice(-2);
        return { data: Float32Array.from(t.data), width: ow, height: oh };
    }

    async function faces(img) {
        const s = await session('face');
        // The model takes a fixed 640×640 input: letterbox the photo into its top-left
        const scale = 640 / Math.max(img.width, img.height);
        const iw = Math.round(img.width * scale);
        const ih = Math.round(img.height * scale);
        const fitted = toChw(resize(img, iw, ih), null, null, true);
        const canvas = new Float32Array(3 * 640 * 640);
        for (let c = 0; c < 3; c++) for (let y = 0; y < ih; y++) canvas.set(fitted.subarray(c * iw * ih + y * iw, c * iw * ih + (y + 1) * iw), c * 640 * 640 + y * 640);
        const out = await s.run({ input: new ort.Tensor('float32', canvas, [1, 3, 640, 640]) });
        const w = 640;
        const h = 640;
        const found = [];
        for (const stride of [8, 16, 32]) {
            const cols = Math.ceil(w / stride);
            const rows = Math.ceil(h / stride);
            const cls = out[`cls_${stride}`].data;
            const obj = out[`obj_${stride}`].data;
            const box = out[`bbox_${stride}`].data;
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const i = r * cols + c;
                    const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
                    if (score < 0.75) continue;
                    const cx = (c + box[i * 4]) * stride;
                    const cy = (r + box[i * 4 + 1]) * stride;
                    const bw = Math.exp(box[i * 4 + 2]) * stride;
                    const bh = Math.exp(box[i * 4 + 3]) * stride;
                    found.push({ x: (cx - bw / 2) / iw, y: (cy - bh / 2) / ih, w: bw / iw, h: bh / ih, score });
                }
            }
        }
        found.sort((a, b) => b.score - a.score);
        const kept = [];
        for (const f of found) if (kept.every(k => iou(k, f) < 0.3)) kept.push(f);
        return kept.slice(0, 8).map(f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Math.round(v * 1000) / 1000])));
    }

    // All masks resampled to one size (≤ MASK_SIZE on the long side)
    async function compute(img) {
        const scale = Math.min(1, MASK_SIZE / Math.max(img.width, img.height));
        const width = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);
        const result = { width, height };
        for (const [name, fn] of [['depth', depth], ['sky', sky], ['subject', matte]]) {
            try {
                const m = await fn(img);
                result[name] = resizeChannel(m.data, m.width, m.height, width, height);
            } catch (error) {
                log.warn(`Mask ${name} failed: ${error.message}`);
            }
        }
        try {
            result.faces = await faces(img);
        } catch (error) {
            log.warn(`Face detection failed: ${error.message}`);
            result.faces = [];
        }
        return result;
    }

    return { compute, depth, sky, matte, faces };
}
