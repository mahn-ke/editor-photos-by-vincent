// Preview renderer: keeps a ≤1.6 MP copy of the photo and renders recipes on demand
import { applyTone, fromRGBA8, render, resize, toRGBA8 } from './pipeline.js';
import { normalizeRecipe } from './recipe.js';
import { measure } from './auto.js';

const PREVIEW_PIXELS = 1.6e6;
let source = null;
let thumb = null;

const clone = img => ({ width: img.width, height: img.height, data: Float32Array.from(img.data) });

async function load(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    const scale = Math.min(1, Math.sqrt(PREVIEW_PIXELS / (bitmap.width * bitmap.height)));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    source = fromRGBA8(ctx.getImageData(0, 0, width, height).data, width, height);
    const t = Math.min(1, 220 / Math.max(width, height));
    thumb = resize(source, Math.max(1, Math.round(width * t)), Math.max(1, Math.round(height * t)));
    return { width, height, stats: measure(source) };
}

function reply(id, img, extra = {}) {
    const rgba = toRGBA8(img);
    self.postMessage({ id, width: img.width, height: img.height, rgba, ...extra }, [rgba.buffer]);
}

self.onmessage = async ({ data }) => {
    const { id, type } = data;
    try {
        if (type === 'load') {
            self.postMessage({ id, ...(await load(data.url)) });
        } else if (type === 'render') {
            const recipe = normalizeRecipe(data.recipe);
            // 'tone' keeps the full frame (the crop tab draws rotation and crop itself)
            const img = data.mode === 'tone' ? applyTone(clone(source), recipe) : render(source, recipe);
            reply(id, img);
        } else if (type === 'thumbs') {
            const results = data.recipes.map(recipe => {
                const img = render(thumb, normalizeRecipe(recipe));
                const rgba = toRGBA8(img);
                return { width: img.width, height: img.height, rgba };
            });
            self.postMessage({ id, results }, results.map(r => r.rgba.buffer));
        }
    } catch (error) {
        self.postMessage({ id, error: error.message });
    }
};
