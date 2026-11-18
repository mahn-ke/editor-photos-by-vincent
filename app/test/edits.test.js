import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import sharp from 'sharp';
import { generateLibrary } from './fake-immich.js';
import { Browser, startStack } from './helpers.js';

const library = generateLibrary({ months: 1, now: new Date('2026-11-18T12:00:00Z') });
const photo = library[0].assets.find(a => a.isImage);
const RECIPE = { geometry: { angle: 2.5 }, adjust: { contrast: 0.3, pop: 0.2 } };
let stack;
let browser;

before(async () => {
    stack = await startStack({ library });
});
after(() => stack.close());
beforeEach(async () => {
    browser = new Browser(stack.baseUrl);
    await browser.signIn();
});

async function call(path, body) {
    const response = await browser.request(path, body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: stack.baseUrl },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

// Browser.request doesn't send bodies; extend it for this file
const originalRequest = (await import('./helpers.js')).Browser.prototype.request;
(await import('./helpers.js')).Browser.prototype.request = async function (path, options = {}) {
    if (!options.body) return originalRequest.call(this, path, options);
    const cookie = [...this.cookies].map(([n, v]) => `${n}=${v}`).join('; ');
    return fetch(this.baseUrl + path, { method: options.method, redirect: 'manual', headers: { cookie, ...options.headers }, body: options.body });
};

async function saveAndWait(id, recipe, source) {
    const started = await call(`/api/edit/${id}/save`, { recipe, source });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    for (let i = 0; i < 100; i++) {
        const job = await call(`/api/jobs/${started.body.jobId}`);
        if (job.body.status === 'done') return job.body.result;
        if (job.body.status === 'error') throw new Error(job.body.error);
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('timeout');
}

const editsOf = id => stack.fake.metadata.get(id)?.get('editor-photos')?.edits ?? [];

describe('editor', () => {
    test('the editor page and context require a session', async () => {
        const anon = new Browser(stack.baseUrl);
        const page = await anon.request(`/edit/${photo.id}`);
        assert.equal(page.status, 302);
        assert.match(page.headers.get('location'), /^\/auth\/login\?return=%2Fedit%2F/);
        assert.equal((await anon.request(`/api/edit/${photo.id}`)).status, 401);
        assert.equal((await browser.request('/edit/not-a-uuid')).status, 404);
        assert.equal((await browser.request(`/edit/${photo.id}`)).status, 200);
    });

    test('context of an unedited photo starts from an empty recipe and hides people data', async () => {
        const { status, body } = await call(`/api/edit/${photo.id}`);
        assert.equal(status, 200);
        assert.equal(body.original.id, photo.id);
        assert.equal(body.editable, true);
        assert.deepEqual(body.edits, []);
        assert.equal(body.recipe.geometry.angle, 0);
        assert.doesNotMatch(JSON.stringify(body), /Should never leave the server/);
    });

    test('saving renders, uploads, stacks the new version on top and records the edit', async () => {
        const result = await saveAndWait(photo.id, RECIPE, 'manual');
        const rendered = stack.fake.assets.get(result.renderedAssetId);
        assert.ok(rendered, 'uploaded');
        assert.match(rendered.originalFileName, /-edit-1\.jpg$/);
        const meta = await sharp(stack.fake.uploads.get(rendered.id)).metadata();
        assert.equal(meta.format, 'jpeg');
        assert.ok(meta.exif, 'carries EXIF dates');
        assert.ok(rendered.dateTimeOriginal, 'timeline date copied from the original');
        assert.equal(stack.fake.metadata.get(rendered.id).get('editor-photos-render').originalId, photo.id);
        const s = stack.fake.stackOf(photo.id);
        assert.equal(s.primaryAssetId, rendered.id);
        assert.deepEqual(s.assetIds.sort(), [photo.id, rendered.id].sort());
        assert.equal(editsOf(photo.id).length, 1);
        assert.equal(editsOf(photo.id)[0].recipe.geometry.angle, 2.5);
        assert.ok(stack.fake.copies.some(c => c.sourceId === photo.id && c.targetId === rendered.id && c.albums && c.stack === false));
        assert.equal(stack.events.at(-1).type, 'manual-edit');
    });

    test('opening a rendered version edits its original, starting from the shown recipe', async () => {
        const [edit] = editsOf(photo.id);
        const { body } = await call(`/api/edit/${edit.renderedAssetId}`);
        assert.equal(body.original.id, photo.id);
        assert.equal(body.shownEditId, edit.id);
        assert.equal(body.recipe.adjust.contrast, 0.3);
    });

    test('a second save merges into the same stack and becomes the shown version', async () => {
        const result = await saveAndWait(photo.id, { ...RECIPE, filter: { id: 'mono', strength: 1 } }, 'suggestion');
        const s = stack.fake.stackOf(photo.id);
        assert.equal(s.primaryAssetId, result.renderedAssetId);
        assert.equal(s.assetIds.length, 3);
        assert.equal(editsOf(photo.id).length, 2);
        assert.equal(editsOf(photo.id)[1].source, 'suggestion');
    });

    test('switching the shown version moves the stack primary', async () => {
        const [first] = editsOf(photo.id);
        assert.equal((await call(`/api/edit/${photo.id}/show`, { editId: first.id })).status, 200);
        assert.equal(stack.fake.stackOf(photo.id).primaryAssetId, first.renderedAssetId);
        await call(`/api/edit/${photo.id}/show`, { editId: null });
        assert.equal(stack.fake.stackOf(photo.id).primaryAssetId, photo.id);
    });

    test('discarding the shown version hands over to the newest remaining one, then trashes it', async () => {
        const [first, second] = editsOf(photo.id);
        await call(`/api/edit/${photo.id}/show`, { editId: first.id });
        const res = await call(`/api/edit/${photo.id}/discard`, { editId: first.id });
        assert.equal(res.status, 200);
        assert.equal(stack.fake.assets.get(first.renderedAssetId).isTrashed, true);
        const s = stack.fake.stackOf(photo.id);
        assert.equal(s.primaryAssetId, second.renderedAssetId);
        assert.ok(!s.assetIds.includes(first.renderedAssetId));
        assert.deepEqual(editsOf(photo.id).map(e => e.id), [second.id]);
        assert.equal(stack.events.at(-1).type, 'version-discarded');
    });

    test('discarding all edits dissolves the stack and removes the metadata', async () => {
        const [second] = editsOf(photo.id);
        const res = await call(`/api/edit/${photo.id}/discard`, { all: true });
        assert.equal(res.status, 200);
        assert.equal(stack.fake.stackOf(photo.id), null);
        assert.equal(stack.fake.assets.get(second.renderedAssetId).isTrashed, true);
        assert.equal(stack.fake.metadata.get(photo.id).has('editor-photos'), false);
        assert.equal(stack.fake.assets.get(photo.id).isTrashed ?? false, false, 'the original is never trashed');
    });

    test('refuses empty edits, unknown edits and cross-origin writes', async () => {
        const started = await call(`/api/edit/${photo.id}/save`, { recipe: {} });
        let job;
        for (let i = 0; i < 50; i++) {
            job = (await call(`/api/jobs/${started.body.jobId}`)).body;
            if (job.status !== 'queued' && job.status !== 'running') break;
            await new Promise(r => setTimeout(r, 20));
        }
        assert.equal(job.status, 'error');
        assert.match(job.error, /Nothing to save/);
        assert.equal((await call(`/api/edit/${photo.id}/discard`, { editId: 'nope' })).status, 404);
        const crossOrigin = await fetch(`${stack.baseUrl}/api/edit/${photo.id}/discard`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: [...browser.cookies].map(([n, v]) => `${n}=${v}`).join('; '), origin: 'https://evil.example' },
            body: JSON.stringify({ all: true }),
        });
        assert.equal(crossOrigin.status, 403);
    });

    test('jobs are private to their user', async () => {
        const started = await call(`/api/edit/${photo.id}/save`, { recipe: RECIPE });
        assert.equal(stack.editor.job(started.body.jobId, 'someone-else'), null);
        assert.equal((await call('/api/jobs/00000000-0000-4000-8000-000000000000')).status, 404);
        for (let i = 0; i < 100; i++) {
            const job = await call(`/api/jobs/${started.body.jobId}`);
            if (job.body.status === 'done') break;
            await new Promise(r => setTimeout(r, 50));
        }
        await call(`/api/edit/${photo.id}/discard`, { all: true });
    });
});
