// Mask-based tools: Sky, Color focus, Portrait light and Blur. Masks arrive already in
// the image's geometry: { sky, subject, depth } as Float32Arrays (0..1) of the image's
// size, and faces as boxes normalised to the image.

import { blurChannel } from './pipeline.js';

// Our own sky looks (gradient top → horizon, luminance gain, saturation, contrast)
export const SKY_LOOKS = {
    vivid: { top: [0.12, 0.32, 0.85], bottom: [0.45, 0.7, 0.98], tint: 0.18, lum: 0.97, sat: 1.45, contrast: 0.15 },
    luminous: { top: [0.35, 0.65, 0.98], bottom: [0.85, 0.95, 1], tint: 0.25, lum: 1.12, sat: 1.1, contrast: 0 },
    radiant: { top: [0.3, 0.45, 0.85], bottom: [1, 0.78, 0.45], tint: 0.35, lum: 1.05, sat: 1.25, contrast: 0.08, scene: [1.03, 1.0, 0.96] },
    ember: { top: [0.45, 0.25, 0.45], bottom: [1, 0.48, 0.18], tint: 0.5, lum: 0.98, sat: 1.35, contrast: 0.1, scene: [1.06, 0.99, 0.93] },
    airy: { top: [0.62, 0.78, 0.95], bottom: [0.9, 0.95, 1], tint: 0.35, lum: 1.15, sat: 0.8, contrast: -0.1, scene: [0.98, 1, 1.03] },
    afterglow: { top: [0.38, 0.32, 0.7], bottom: [1, 0.62, 0.68], tint: 0.45, lum: 1.0, sat: 1.2, contrast: 0.05, scene: [1.03, 0.99, 1.0] },
    stormy: { top: [0.22, 0.25, 0.32], bottom: [0.5, 0.53, 0.58], tint: 0.35, lum: 0.8, sat: 0.55, contrast: 0.3, scene: [0.97, 0.98, 1.0] },
};

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

export function applyTools(img, recipe, masks) {
    const t = recipe.tools;
    if (!masks) return img;
    const { width, height, data } = img;
    const n = width * height;

    if (t.sky.strength > 0 && masks.sky) {
        const look = SKY_LOOKS[t.sky.palette] ?? SKY_LOOKS.vivid;
        const s0 = t.sky.strength;
        for (let p = 0, j = 0; p < n; p++, j += 3) {
            const y = Math.floor(p / width) / height;
            const m = masks.sky[p] * s0;
            const sceneW = (1 - masks.sky[p]) * s0 * 0.5;
            if (look.scene && sceneW > 0) for (let c = 0; c < 3; c++) data[j + c] *= 1 + (look.scene[c] - 1) * sceneW;
            if (m <= 0.002) continue;
            const r = data[j], g = data[j + 1], b = data[j + 2];
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const gy = Math.min(1, y * 1.6);
            for (let c = 0; c < 3; c++) {
                const target = look.top[c] + (look.bottom[c] - look.top[c]) * gy;
                let v = data[j + c];
                v = l + (v - l) * look.sat; // saturation
                v = 0.5 + (v - 0.5) * (1 + look.contrast); // contrast
                v *= look.lum;
                v = v * (1 - look.tint) + target * (l * 1.2 + 0.2) * look.tint; // colour grade
                data[j + c] = data[j + c] + (v - data[j + c]) * m;
            }
        }
    }

    if (t.colorFocus.strength > 0 && (masks.subject || masks.depth)) {
        const s0 = t.colorFocus.strength;
        for (let p = 0, j = 0; p < n; p++, j += 3) {
            const keep = masks.subject ? masks.subject[p] : clamp01((masks.depth[p] - 0.55) * 4);
            const w = (1 - keep) * s0;
            if (w <= 0) continue;
            const l = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
            for (let c = 0; c < 3; c++) data[j + c] += (l - data[j + c]) * w;
        }
    }

    if (t.portraitLight.strength > 0 && masks.faces?.length) {
        const s0 = t.portraitLight.strength;
        const lx = t.portraitLight.x - 0.5;
        const ly = t.portraitLight.y - 0.5;
        const gain = new Float32Array(n);
        for (const f of masks.faces) {
            const size = Math.max(f.w * width, f.h * height);
            const cx = (f.x + f.w / 2) * width + lx * size * 0.9;
            const cy = (f.y + f.h / 2) * height + ly * size * 0.9;
            const radius = size * 1.4;
            const x0 = Math.max(0, Math.floor(cx - radius * 2)), x1 = Math.min(width, Math.ceil(cx + radius * 2));
            const y0 = Math.max(0, Math.floor(cy - radius * 2)), y1 = Math.min(height, Math.ceil(cy + radius * 2));
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (radius * radius);
                    gain[y * width + x] = Math.max(gain[y * width + x], Math.exp(-d2));
                }
            }
        }
        for (let p = 0, j = 0; p < n; p++, j += 3) {
            if (!gain[p]) continue;
            const subject = masks.subject ? 0.35 + 0.65 * masks.subject[p] : 1;
            const k = 1 + s0 * 0.55 * gain[p] * subject;
            data[j] = Math.min(1, data[j] * k * 1.01);
            data[j + 1] = Math.min(1, data[j + 1] * k);
            data[j + 2] = Math.min(1, data[j + 2] * k * 0.985);
        }
    }

    if (t.blur.strength > 0 && masks.depth) {
        const s0 = t.blur.strength;
        const fx = Math.min(width - 1, Math.max(0, Math.round(t.blur.focus.x * width)));
        const fy = Math.min(height - 1, Math.max(0, Math.round(t.blur.focus.y * height)));
        const focusDepth = masks.depth[fy * width + fx];
        const diag = Math.hypot(width, height);
        const radii = [0.004, 0.011, 0.024].map(r => Math.max(1, r * diag * s0));
        const channels = [0, 1, 2].map(c => Float32Array.from({ length: n }, (_, p) => data[p * 3 + c]));
        const levels = radii.map(r => channels.map(ch => blurChannel(ch, width, height, r)));
        for (let p = 0, j = 0; p < n; p++, j += 3) {
            let amount = Math.min(1, Math.abs(masks.depth[p] - focusDepth) * 3);
            if (masks.subject) amount *= 1 - masks.subject[p] * 0.85;
            const level = amount * 3; // 0..3 across original + three blur levels
            if (level <= 0.02) continue;
            const i = Math.min(2, Math.floor(level));
            const frac = Math.min(1, level - i);
            for (let c = 0; c < 3; c++) {
                const a = i === 0 ? channels[c][p] : levels[i - 1][c][p];
                const b = levels[i][c][p];
                data[j + c] = a + (b - a) * frac;
            }
        }
    }
    return img;
}
