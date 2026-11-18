// Image comparison for the e2e: both images are resized to the same 512 px frame, then we
// report the median colour difference (ΔE76 in CIELAB) and a luminance SSIM.
import sharp from 'sharp';

const SIZE = 512;

async function lab(bytes) {
    const { data, info } = await sharp(bytes).autoOrient().removeAlpha().resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), Y = new Float32Array(n);
    const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    for (let p = 0; p < n; p++) {
        const r = lin(data[p * 3]), g = lin(data[p * 3 + 1]), b = lin(data[p * 3 + 2]);
        const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
        L[p] = 116 * f(y) - 16; A[p] = 500 * (f(x) - f(y)); B[p] = 200 * (f(y) - f(z)); Y[p] = y;
    }
    return { L, A, B, Y, n };
}

function ssim(a, b, n) {
    // Global SSIM on 8×8 blocks of luminance, averaged
    let sum = 0, count = 0;
    for (let by = 0; by < SIZE; by += 8) {
        for (let bx = 0; bx < SIZE; bx += 8) {
            let ma = 0, mb = 0;
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const p = (by + y) * SIZE + bx + x; ma += a[p]; mb += b[p]; }
            ma /= 64; mb /= 64;
            let va = 0, vb = 0, cov = 0;
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const p = (by + y) * SIZE + bx + x; va += (a[p] - ma) ** 2; vb += (b[p] - mb) ** 2; cov += (a[p] - ma) * (b[p] - mb); }
            va /= 63; vb /= 63; cov /= 63;
            const c1 = 0.0001, c2 = 0.0009;
            sum += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
            count++;
        }
    }
    return sum / count;
}

export async function compareImages(aBytes, bBytes) {
    const [a, b] = await Promise.all([lab(aBytes), lab(bBytes)]);
    const de = new Float32Array(a.n);
    for (let p = 0; p < a.n; p++) de[p] = Math.hypot(a.L[p] - b.L[p], a.A[p] - b.A[p], a.B[p] - b.B[p]);
    const sorted = Array.from(de).sort((x, y) => x - y);
    return {
        medianDeltaE: Math.round(sorted[Math.floor(a.n / 2)] * 100) / 100,
        p95DeltaE: Math.round(sorted[Math.floor(a.n * 0.95)] * 100) / 100,
        ssim: Math.round(ssim(a.Y, b.Y, a.n) * 1000) / 1000,
    };
}
