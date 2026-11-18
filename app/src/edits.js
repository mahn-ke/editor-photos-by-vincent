// Saving edits as Immich versions, switching the shown version and discarding them.
//
// Layout in Immich:
// - the original keeps metadata key `editor-photos` = { v: 1, edits: [{ id, createdAt, source, renderedAssetId, recipe }] }
// - each rendered version is a separate JPEG with metadata `editor-photos-render` = { v: 1, originalId, editId }
// - original, rendered versions (and a RAW sibling) share one stack; its primary is the version shown

import { randomUUID } from 'node:crypto';
import { describeRecipe, isIdentity, normalizeRecipe } from '../public/edit/recipe.js';
import { filterNames } from '../public/edit/filters.js';
import { decode, encodeJpeg, exifDates } from './render.js';

export const EDITS_KEY = 'editor-photos';
export const RENDER_KEY = 'editor-photos-render';
const SOURCES = new Set(['manual', 'suggestion']);

function stripExtension(name) {
    const base = String(name || 'photo').replace(/\.[^.]+$/, '');
    return base.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'photo';
}

export function createEditor({ immich, renderPool, log = console, onEvent = () => {} }) {
    const jobs = new Map();
    let queue = Promise.resolve();

    async function editsOf(token, originalId) {
        const meta = await immich.metadata(token, originalId);
        const value = meta[EDITS_KEY];
        return Array.isArray(value?.edits) ? value.edits : [];
    }

    async function writeEdits(token, originalId, edits) {
        if (edits.length) await immich.setMetadata(token, originalId, EDITS_KEY, { v: 1, edits });
        else await immich.deleteMetadata(token, originalId, EDITS_KEY);
    }

    // Any asset of a stack (original or rendered version) leads to the original
    async function resolveOriginal(token, assetId) {
        const meta = await immich.metadata(token, assetId);
        const pointer = meta[RENDER_KEY];
        if (pointer?.originalId && pointer.originalId !== assetId) return pointer.originalId;
        return assetId;
    }

    async function sourcePixels(token, original) {
        try {
            const response = await immich.original(token, original.id);
            const bytes = Buffer.from(await response.arrayBuffer());
            return { decoded: await decode(bytes), from: 'original' };
        } catch (error) {
            // HEIC/RAW originals sharp can't read: use Immich's largest derivative instead
            log.warn(`Rendering ${original.id} from Immich's preview: ${error.message}`);
            const response = await immich.media(token, original.id, 'preview');
            if (!response.ok) throw new Error(`No usable source image (${response.status})`);
            const bytes = Buffer.from(await response.arrayBuffer());
            return { decoded: await decode(bytes), from: 'preview' };
        }
    }

    async function context(token, assetId) {
        const originalId = await resolveOriginal(token, assetId);
        const original = await immich.asset(token, originalId);
        const edits = await editsOf(token, originalId);
        const stack = original.stack?.id ? await immich.stack(token, original.stack.id).catch(() => null) : null;
        const primaryId = stack?.primaryAssetId ?? originalId;
        const shown = edits.find(edit => edit.renderedAssetId === primaryId) ?? null;
        const names = filterNames();
        return {
            original: {
                id: original.id,
                fileName: original.originalFileName,
                type: original.type,
                width: original.width ?? original.exifInfo?.exifImageWidth ?? null,
                height: original.height ?? original.exifInfo?.exifImageHeight ?? null,
                takenAt: original.localDateTime ?? original.fileCreatedAt,
                mime: original.originalMimeType,
            },
            editable: original.type === 'IMAGE',
            stackId: stack?.id ?? null,
            shownEditId: shown?.id ?? null,
            recipe: normalizeRecipe((shown ?? edits.at(-1))?.recipe ?? {}),
            edits: edits.map(edit => ({
                id: edit.id,
                createdAt: edit.createdAt,
                source: edit.source,
                renderedAssetId: edit.renderedAssetId,
                summary: describeRecipe(edit.recipe, names),
            })),
        };
    }

    async function save(token, originalId, rawRecipe, source, report) {
        const recipe = normalizeRecipe(rawRecipe);
        if (isIdentity(recipe)) throw Object.assign(new Error('Nothing to save: the edit makes no changes'), { status: 400 });
        report('Loading the original');
        const original = await immich.asset(token, originalId);
        if (original.type !== 'IMAGE') throw Object.assign(new Error('Only photos can be edited'), { status: 400 });
        const { decoded, from } = await sourcePixels(token, original);
        report(`Rendering ${decoded.width}×${decoded.height}`);
        const rendered = await renderPool.render(decoded, recipe);
        const dates = exifDates(original.fileCreatedAt, original.localDateTime);
        const jpeg = await encodeJpeg(rendered, { make: original.exifInfo?.make, model: original.exifInfo?.model, dates });

        report('Uploading to Immich');
        const edits = await editsOf(token, originalId);
        const editId = randomUUID();
        const filename = `${stripExtension(original.originalFileName)}-edit-${edits.length + 1}.jpg`;
        const uploaded = await immich.upload(token, {
            bytes: jpeg,
            filename,
            fileCreatedAt: original.fileCreatedAt,
            fileModifiedAt: original.fileModifiedAt ?? original.fileCreatedAt,
            metadata: [{ key: RENDER_KEY, value: { v: 1, originalId, editId } }],
        });
        const renderedAssetId = uploaded.id;
        if (uploaded.status === 'duplicate') await immich.setMetadata(token, renderedAssetId, RENDER_KEY, { v: 1, originalId, editId });

        // Same place in the timeline, same albums, favourite and shared links as the original
        const exif = original.exifInfo ?? {};
        const update = {};
        if (dates) update.dateTimeOriginal = dates.iso;
        if (Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)) {
            update.latitude = exif.latitude;
            update.longitude = exif.longitude;
        }
        if (Object.keys(update).length) await immich.updateAsset(token, renderedAssetId, update);
        await immich.copyAsset(token, { sourceId: originalId, targetId: renderedAssetId, albums: true, sharedLinks: true, favorite: true, sidecar: true, stack: false });

        report('Stacking the new version');
        const fresh = await immich.asset(token, originalId);
        const currentPrimary = fresh.stack?.primaryAssetId ?? originalId;
        await immich.createStack(token, [renderedAssetId, currentPrimary]);

        edits.push({ id: editId, createdAt: new Date().toISOString(), source: SOURCES.has(source) ? source : 'manual', renderedAssetId, recipe, from });
        await writeEdits(token, originalId, edits);
        onEvent({ type: source === 'suggestion' ? 'suggestion-saved' : 'manual-edit', originalId, editId, recipe });
        return { editId, renderedAssetId, width: rendered.width, height: rendered.height, from };
    }

    async function discard(token, originalId, editId) {
        const edits = await editsOf(token, originalId);
        const targets = editId === 'all' ? [...edits].reverse() : edits.filter(edit => edit.id === editId);
        if (!targets.length) throw Object.assign(new Error('No such edit'), { status: 404 });
        let remainingEdits = edits;
        for (const edit of targets) {
            remainingEdits = remainingEdits.filter(e => e.id !== edit.id);
            const original = await immich.asset(token, originalId);
            const stackId = original.stack?.id;
            if (stackId) {
                const stack = await immich.stack(token, stackId).catch(() => null);
                const members = (stack?.assets ?? []).map(a => a.id);
                if (stack && members.includes(edit.renderedAssetId)) {
                    const others = members.filter(id => id !== edit.renderedAssetId);
                    if (others.length <= 1) {
                        await immich.deleteStack(token, stackId);
                    } else if (stack.primaryAssetId === edit.renderedAssetId) {
                        // Trashing the primary would hide the whole stack: hand over first
                        const fallback = [...remainingEdits].reverse().find(e => others.includes(e.renderedAssetId))?.renderedAssetId ?? originalId;
                        await immich.setStackPrimary(token, stackId, fallback);
                        await immich.removeFromStack(token, stackId, edit.renderedAssetId);
                    } else {
                        await immich.removeFromStack(token, stackId, edit.renderedAssetId);
                    }
                }
            }
            await immich.trash(token, [edit.renderedAssetId]);
            await writeEdits(token, originalId, remainingEdits);
            onEvent({ type: 'version-discarded', originalId, editId: edit.id, source: edit.source, recipe: edit.recipe });
        }
        return { remaining: remainingEdits.length };
    }

    async function show(token, originalId, editId) {
        const edits = await editsOf(token, originalId);
        const target = editId ? edits.find(edit => edit.id === editId)?.renderedAssetId : originalId;
        if (!target) throw Object.assign(new Error('No such edit'), { status: 404 });
        const original = await immich.asset(token, originalId);
        if (!original.stack?.id) throw Object.assign(new Error('This photo has no versions'), { status: 400 });
        await immich.setStackPrimary(token, original.stack.id, target);
    }

    // Saves run one at a time; the browser polls the job
    function startSave({ token, userId, originalId, recipe, source }) {
        const id = randomUUID();
        const job = { id, userId, status: 'queued', step: 'Waiting', result: null, error: null, createdAt: Date.now() };
        jobs.set(id, job);
        queue = queue.then(async () => {
            job.status = 'running';
            try {
                job.result = await save(token, originalId, recipe, source, step => { job.step = step; });
                job.status = 'done';
                job.step = 'Saved';
            } catch (error) {
                job.status = 'error';
                job.error = error.status && error.status < 500 ? error.message : 'Saving failed';
                job.unauthorized = error.name === 'ImmichUnauthorized';
                log.error(`Saving an edit of ${originalId} failed: ${error.message}`);
            }
        });
        // Forget finished jobs after 10 minutes
        for (const [key, value] of jobs) if (Date.now() - value.createdAt > 600000 && value.status !== 'running') jobs.delete(key);
        return job;
    }

    function job(id, userId) {
        const entry = jobs.get(id);
        if (!entry || entry.userId !== userId) return null;
        const { token, ...visible } = entry;
        return visible;
    }

    return { context, save, discard, show, startSave, job, resolveOriginal };
}
