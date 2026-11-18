// Crop and straighten maths shared by the crop UI and the renderers.
//
// Model (like Google Photos): the crop frame is axis-aligned on screen and the image is
// rotated behind it by `angle`. In image coordinates the crop is therefore a rectangle
// rotated by -angle around its centre (cx, cy). `crop` is stored normalised to the image
// after the 90° rotation: cx, w as fractions of its width, cy, h as fractions of its height.

const DEG = Math.PI / 180;

export function orientedSize(width, height, rotate90 = 0) {
    return rotate90 % 2 ? { width: height, height: width } : { width, height };
}

// Extent of a w×h rectangle rotated by angle, measured along the image axes
export function rotatedExtent(w, h, angleDeg) {
    const c = Math.abs(Math.cos(angleDeg * DEG));
    const s = Math.abs(Math.sin(angleDeg * DEG));
    return { bw: w * c + h * s, bh: w * s + h * c };
}

// Largest rectangle with the given aspect (w/h) centred at (cx, cy) px that stays inside
// a W×H image when rotated by angle. A rotated rectangle is inside an axis-aligned image
// exactly when its axis-aligned bounding box is.
export function maxRectAt(W, H, angleDeg, aspect, cx = W / 2, cy = H / 2) {
    const c = Math.abs(Math.cos(angleDeg * DEG));
    const s = Math.abs(Math.sin(angleDeg * DEG));
    const halfX = Math.max(0, Math.min(cx, W - cx));
    const halfY = Math.max(0, Math.min(cy, H - cy));
    const h = Math.min((2 * halfX) / (aspect * c + s), (2 * halfY) / (aspect * s + c));
    return { w: aspect * h, h };
}

export function aspectValue(aspectId, W, H, aspects) {
    if (aspectId === 'original') return W / H;
    const entry = aspects.find(([id]) => id === aspectId);
    return entry && entry[2] ? entry[2] : null;
}

export function cropToPixels(crop, W, H) {
    const c = crop || { cx: 0.5, cy: 0.5, w: 1, h: 1 };
    return { cx: c.cx * W, cy: c.cy * H, w: c.w * W, h: c.h * H };
}

export function pixelsToCrop(rect, W, H) {
    return { cx: rect.cx / W, cy: rect.cy / H, w: rect.w / W, h: rect.h / H };
}

export function fitsInside(rect, W, H, angleDeg, epsilon = 0.5) {
    const { bw, bh } = rotatedExtent(rect.w, rect.h, angleDeg);
    return rect.cx - bw / 2 >= -epsilon && rect.cx + bw / 2 <= W + epsilon
        && rect.cy - bh / 2 >= -epsilon && rect.cy + bh / 2 <= H + epsilon;
}

// Shrinks a rectangle around its centre (keeping its aspect) until it fits at `angle`,
// first moving the centre inwards if the rectangle could fit elsewhere
export function constrainRect(rect, W, H, angleDeg) {
    const out = { ...rect };
    const { bw, bh } = rotatedExtent(out.w, out.h, angleDeg);
    if (bw <= W) out.cx = Math.min(Math.max(out.cx, bw / 2), W - bw / 2);
    if (bh <= H) out.cy = Math.min(Math.max(out.cy, bh / 2), H - bh / 2);
    if (!fitsInside(out, W, H, angleDeg)) {
        const max = maxRectAt(W, H, angleDeg, out.w / out.h, out.cx, out.cy);
        const scale = Math.min(1, max.w / out.w);
        out.w *= scale;
        out.h *= scale;
    }
    return out;
}

// The crop shown when nothing has been chosen yet: as large as possible at this angle
export function defaultRect(W, H, angleDeg, aspect = null) {
    const ratio = aspect || W / H;
    const max = maxRectAt(W, H, angleDeg, ratio);
    return { cx: W / 2, cy: H / 2, w: max.w, h: max.h };
}

// Effective crop for rendering: the stored crop, or the default, always constrained
export function effectiveRect(geometry, W0, H0) {
    const { width: W, height: H } = orientedSize(W0, H0, geometry.rotate90);
    const angle = geometry.angle || 0;
    const rect = geometry.crop ? cropToPixels(geometry.crop, W, H) : defaultRect(W, H, angle);
    return { W, H, rect: constrainRect(rect, W, H, angle) };
}

// Maps an output pixel (u, v) of the cropped result to source coordinates in the
// original (unrotated) image. Returned function writes into `out` to avoid allocation.
export function outputMapping(geometry, W0, H0, outWidth, outHeight) {
    const { W, H, rect } = effectiveRect(geometry, W0, H0);
    const angle = (geometry.angle || 0) * DEG;
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const sx = rect.w / outWidth;
    const sy = rect.h / outHeight;
    const k = geometry.rotate90 || 0;
    return (u, v, out) => {
        // Position inside the crop, relative to its centre, in oriented-image pixels
        const dx = (u + 0.5) * sx - rect.w / 2;
        const dy = (v + 0.5) * sy - rect.h / 2;
        const x = rect.cx + dx * cos - dy * sin;
        const y = rect.cy + dx * sin + dy * cos;
        // Undo the 90° rotation (clockwise steps) to reach original-image coordinates
        if (k === 0) { out[0] = x; out[1] = y; }
        else if (k === 1) { out[0] = y; out[1] = W - x; }
        else if (k === 2) { out[0] = W - x; out[1] = H - y; }
        else { out[0] = H - y; out[1] = x; }
        return out;
    };
}

// Output size for a render: crop size in source pixels, optionally limited to maxPixels
export function outputSize(geometry, W0, H0, maxPixels = Infinity) {
    const { rect } = effectiveRect(geometry, W0, H0);
    let w = rect.w;
    let h = rect.h;
    const pixels = w * h;
    if (pixels > maxPixels) {
        const scale = Math.sqrt(maxPixels / pixels);
        w *= scale;
        h *= scale;
    }
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}
