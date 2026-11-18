// Runs the shared pixel pipeline off the main thread
import { parentPort } from 'node:worker_threads';
import { fromRGB, render, toRGB8 } from '../public/edit/pipeline.js';
import { applyTools } from '../public/edit/tools.js';

parentPort.on('message', ({ id, width, height, depth, buffer, recipe, maxPixels, masks }) => {
    try {
        const pixels = depth === 16 ? new Uint16Array(buffer) : new Uint8Array(buffer);
        const src = fromRGB(pixels, width, height, depth === 16 ? 65535 : 255);
        const out = render(src, recipe, { maxPixels: maxPixels ?? Infinity, masks: masks ?? null, tools: masks ? applyTools : null });
        const rgb = toRGB8(out);
        parentPort.postMessage({ id, ok: true, width: out.width, height: out.height, buffer: rgb.buffer }, [rgb.buffer]);
    } catch (error) {
        parentPort.postMessage({ id, ok: false, error: error.message });
    }
});
