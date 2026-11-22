// Caches the Tools masks per asset (computed from Immich's preview) as 8-bit PNGs plus a
// small JSON with face boxes and coverage. Faces are stored only as boxes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fromRGB } from '../public/edit/pipeline.js';

export const MASK_KINDS = ['sky', 'subject', 'depth'];

// `previewOf(auth, assetId)` may supply the preview bytes (a RAW kept as the original is masked
// on its camera look, not on Immich's rendering of the whole sensor)
export function createMaskStore({ masker, immich, dataDir, previewOf = null, log = console }) {
    const dir = path.join(dataDir === ':memory:' ? path.join(process.cwd(), 'data') : dataDir, 'masks');
    mkdirSync(dir, { recursive: true });
    const inflight = new Map();
    const file = (assetId, name) => path.join(dir, `${assetId}-${name}`);

    async function build(auth, assetId) {
        let bytes = previewOf ? await previewOf(auth, assetId) : null;
        if (!bytes) {
            const response = await immich.media(auth, assetId, 'preview');
            if (!response.ok) throw new Error(`preview ${response.status}`);
            bytes = Buffer.from(await response.arrayBuffer());
        }
        const { data, info } = await sharp(bytes).autoOrient().removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const masks = await masker.compute(fromRGB(data, info.width, info.height));
        const coverage = {};
        for (const kind of MASK_KINDS) {
            const m = masks[kind];
            if (!m) continue;
            const png = Buffer.from(Uint8Array.from(m, v => Math.round(Math.min(1, Math.max(0, v)) * 255)));
            await sharp(png, { raw: { width: masks.width, height: masks.height, channels: 1 } }).png().toFile(file(assetId, `${kind}.png`));
            coverage[kind] = m.reduce((s, v) => s + (v > 0.5 ? 1 : 0), 0) / m.length;
        }
        const info2 = { width: masks.width, height: masks.height, faces: masks.faces ?? [], kinds: MASK_KINDS.filter(k => masks[k]), coverage };
        writeFileSync(file(assetId, 'info.json'), JSON.stringify(info2));
        log.info?.(`Masks ready for ${assetId}: sky ${Math.round((coverage.sky ?? 0) * 100)}%, subject ${Math.round((coverage.subject ?? 0) * 100)}%, ${info2.faces.length} face(s)`);
        return info2;
    }

    async function info(auth, assetId) {
        const cached = file(assetId, 'info.json');
        if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
        if (!inflight.has(assetId)) inflight.set(assetId, build(auth, assetId).finally(() => inflight.delete(assetId)));
        return inflight.get(assetId);
    }

    function png(assetId, kind) {
        if (!MASK_KINDS.includes(kind)) return null;
        const f = file(assetId, `${kind}.png`);
        return existsSync(f) ? readFileSync(f) : null;
    }

    // Masks as Float32Arrays for the renderer
    async function load(auth, assetId) {
        const meta = await info(auth, assetId);
        const masks = { width: meta.width, height: meta.height, faces: meta.faces };
        for (const kind of meta.kinds) {
            const { data } = await sharp(png(assetId, kind)).raw().toBuffer({ resolveWithObject: true });
            masks[kind] = Float32Array.from(data, v => v / 255);
        }
        return masks;
    }

    return { info, png, load };
}
