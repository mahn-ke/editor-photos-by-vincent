// Deterministic test images without people or personal content:
// 1. a test chart (grey ramp, colour and skin-tone patches, sky gradient, a horizon tilted 3.5°, fine texture)
// 2. a procedural cityscape with a cloudy sky and a skyline tilted 2.5°
// Usage: node e2e/make-test-images.js <output-dir>
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

// Smooth value noise for clouds
function noise2(width, height, scale, seed) {
    const r = rng(seed);
    const gw = Math.ceil(width / scale) + 2;
    const gh = Math.ceil(height / scale) + 2;
    const grid = Float32Array.from({ length: gw * gh }, r);
    return (x, y) => {
        const gx = x / scale;
        const gy = y / scale;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const v = (i, j) => grid[(y0 + j) * gw + (x0 + i)];
        const top = v(0, 0) + (v(1, 0) - v(0, 0)) * sx;
        const bottom = v(0, 1) + (v(1, 1) - v(0, 1)) * sx;
        return top + (bottom - top) * sy;
    };
}

const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);

export function chart(width = 2400, height = 1800) {
    const px = Buffer.alloc(width * height * 3);
    const tilt = Math.tan((3.5 * Math.PI) / 180);
    const patches = [
        [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
        [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
        [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
    ];
    const r = rng(7);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const j = (y * width + x) * 3;
            const horizon = height * 0.42 - (x - width / 2) * tilt;
            let c;
            if (y < horizon) {
                // Sky gradient from deep to pale blue
                const t = y / horizon;
                c = [70 + 110 * t, 130 + 90 * t, 210 + 35 * t];
            } else if (y < height * 0.62) {
                // Grey ramp with fine texture
                const v = (x / (width - 1)) * 255;
                const tex = ((x >> 2) + (y >> 2)) % 2 ? 6 : -6;
                c = [v + tex, v + tex, v + tex];
            } else {
                const col = Math.floor((x / width) * 6);
                const row = Math.floor(((y - height * 0.62) / (height * 0.38)) * 3);
                c = patches[Math.min(17, row * 6 + col)];
            }
            const n = (r() - 0.5) * 4;
            px[j] = clamp(c[0] + n);
            px[j + 1] = clamp(c[1] + n);
            px[j + 2] = clamp(c[2] + n);
        }
        // A dark horizon line, 3.5° off level
    }
    for (let x = 0; x < width; x++) {
        const yh = Math.round(height * 0.42 - (x - width / 2) * tilt);
        for (let t = -3; t <= 3; t++) {
            const y = yh + t;
            if (y >= 0 && y < height) px.fill(30, (y * width + x) * 3, (y * width + x) * 3 + 3);
        }
    }
    return { width, height, px };
}

export function cityscape(width = 2400, height = 1600) {
    const px = Buffer.alloc(width * height * 3);
    const octaves = [[320, 0.5], [160, 0.25], [80, 0.14], [40, 0.07], [20, 0.04]].map(([scale, amp], i) => [noise2(width, height * 2, scale, 11 + i), amp]);
    const fbm = (x, y) => octaves.reduce((sum, [n, amp]) => sum + n(x, y) * amp, 0);
    const tilt = Math.tan((2.5 * Math.PI) / 180);
    const r = rng(3);
    // Building outline: heights per column block
    const blocks = [];
    for (let x = 0; x < width;) {
        const w = 60 + Math.floor(r() * 160);
        blocks.push({ x0: x, x1: x + w, h: 180 + r() * 520, shade: 25 + r() * 35 });
        x += w;
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const j = (y * width + x) * 3;
            const ground = height * 0.78 - (x - width / 2) * tilt;
            const block = blocks.find(b => x >= b.x0 && x < b.x1);
            const roof = ground - block.h;
            let c;
            if (y < roof) {
                const t = y / ground;
                const v = fbm(x * 1.0, y * 1.8);
                const cl = Math.min(1, Math.max(0, (v - 0.5) * 3.2));
                const sky = [90 + 90 * t, 140 + 70 * t, 215 + 25 * t];
                const cloud = [235, 235, 238];
                c = sky.map((v, i) => v + (cloud[i] - v) * Math.min(1, cl));
            } else if (y < ground) {
                // Facade with lit windows
                const wx = (x - block.x0) % 28;
                const wy = Math.floor(y - roof) % 34;
                const lit = wx > 6 && wx < 20 && wy > 8 && wy < 24 && ((Math.floor((x - block.x0) / 28) * 7 + Math.floor((y - roof) / 34) * 3) % 5 === 0);
                const s = block.shade;
                c = lit ? [230, 200, 120] : [s + 10, s + 12, s + 20];
            } else {
                const t = (y - ground) / (height - ground);
                c = [60 - 20 * t, 62 - 20 * t, 65 - 18 * t];
            }
            const n = (r() - 0.5) * 6;
            px[j] = clamp(c[0] + n);
            px[j + 1] = clamp(c[1] + n);
            px[j + 2] = clamp(c[2] + n);
        }
    }
    return { width, height, px };
}

export async function writeJpeg({ width, height, px }, file, date = '2026:11:01 15:30:00') {
    await sharp(px, { raw: { width, height, channels: 3 } })
        .withExif({ IFD0: { Make: 'editor-photos', Model: 'e2e generator', DateTime: date }, IFD2: { DateTimeOriginal: date, OffsetTimeOriginal: '+01:00' } })
        .jpeg({ quality: 93, chromaSubsampling: '4:4:4' })
        .toFile(file);
    return file;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const dir = process.argv[2] || 'e2e/.tmp';
    mkdirSync(dir, { recursive: true });
    console.log(await writeJpeg(chart(), path.join(dir, 'editor-photos-e2e-chart.jpg'), '2026:11:01 15:30:00'));
    console.log(await writeJpeg(cityscape(), path.join(dir, 'editor-photos-e2e-city.jpg'), '2026:11:01 15:31:00'));
}
