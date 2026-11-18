import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createBackground } from '../src/background.js';
import { createImmichClient } from '../src/immich.js';
import { matchPair, pairKey } from '../src/raw-pairs.js';
import { openStore } from '../src/sessions.js';
import { FAKE_USER, generateLibrary, startFakeImmich } from './fake-immich.js';
import { silentLog } from './helpers.js';

let fake;
let immich;
let token;

function addAsset(name, createdAt, extra = {}) {
    const id = randomUUID();
    fake.assets.set(id, { id, ratio: 1.33, isImage: true, fileCreatedAt: createdAt.replace(/Z$/, ''), localOffsetHours: 0, duration: null, stack: null, originalFileName: name, createdAt: new Date().toISOString(), ...extra });
    return id;
}

before(async () => {
    fake = await startFakeImmich({ library: generateLibrary({ months: 1, now: new Date('2026-11-18T12:00:00Z') }) });
    immich = createImmichClient({ baseUrl: fake.url });
    token = 'session-token';
    fake.tokens.add(token);
});
after(() => fake.close());

function makeBackground(overrides = {}) {
    const store = openStore(':memory:');
    let clock = Date.UTC(2026, 10, 18, 12);
    const bg = createBackground({
        db: store.db, immich, log: silentLog, masterKey: Buffer.alloc(32, 7),
        config: { baseUrl: 'https://editor.photos.example' }, now: () => clock, ...overrides,
    });
    return { bg, store, advance: ms => { clock += ms; } };
}

test('pair keys recognise Pixel RAW naming', () => {
    assert.deepEqual(pairKey('PXL_20260301_101530123.RAW-02.ORIGINAL.dng'), { base: 'PXL_20260301_101530123', variant: '', part: 'raw' });
    assert.deepEqual(pairKey('PXL_20260301_101530123.NIGHT.RAW-01.MP.COVER.jpg'), { base: 'PXL_20260301_101530123', variant: '.NIGHT', part: 'jpeg' });
    assert.equal(pairKey('IMG_1234.jpg'), null);
    const jpeg = { id: 'j', originalFileName: 'PXL_1_1.RAW-01.jpg', fileCreatedAt: '2026-01-01T00:00:00Z' };
    const raw = { id: 'r', originalFileName: 'PXL_1_1.RAW-02.ORIGINAL.dng', fileCreatedAt: '2026-01-01T00:00:01Z' };
    assert.ok(!matchPair([jpeg, raw], { base: 'PXL_1_1' }), 'base needs digits');
    const j2 = { ...jpeg, originalFileName: 'PXL_20260101_000000000.RAW-01.jpg' };
    const r2 = { ...raw, originalFileName: 'PXL_20260101_000000000.RAW-02.ORIGINAL.dng' };
    assert.deepEqual(matchPair([j2, r2], pairKey(j2.originalFileName)), { jpeg: j2, raw: r2 });
    assert.equal(matchPair([j2, { ...r2, fileCreatedAt: '2026-01-01T00:00:09Z' }], pairKey(j2.originalFileName)), null, 'too far apart in time');
});

test('sign-in creates a limited API key and the upload webhook, then the backfill stacks existing pairs', async () => {
    const jpegId = addAsset('PXL_20260301_101530123.RAW-01.MP.COVER.jpg', '2026-03-01T09:15:30.123Z');
    const rawId = addAsset('PXL_20260301_101530123.RAW-02.ORIGINAL.dng', '2026-03-01T09:15:30.123Z');
    const loneRaw = addAsset('PXL_20260302_111111111.RAW-02.ORIGINAL.dng', '2026-03-02T10:11:11.111Z');
    const { bg, store } = makeBackground();
    await bg.ensureUser(token, FAKE_USER.id);
    const [key] = [...fake.apiKeys.values()];
    assert.deepEqual(key.permissions.sort(), ['asset.download', 'asset.read', 'asset.view', 'stack.create', 'stack.read', 'stack.update', 'timeline.read']);
    const row = store.db.prepare('SELECT api_key FROM bg_users').get();
    assert.ok(!Buffer.from(row.api_key).includes(Buffer.from(key.secret)), 'key stored encrypted');
    const [workflow] = [...fake.workflows.values()];
    assert.equal(workflow.trigger, 'AssetMetadataExtraction');
    assert.equal(workflow.steps[0].config.url, `https://editor.photos.example/hooks/immich/${FAKE_USER.id}`);
    await bg.runOnce();
    await bg.runOnce();
    const s = fake.stackOf(jpegId);
    assert.ok(s, 'pair stacked');
    assert.equal(s.primaryAssetId, jpegId, 'the JPEG stays the shown photo');
    assert.deepEqual(s.assetIds.sort(), [jpegId, rawId].sort());
    assert.equal(fake.stackOf(loneRaw), null, 'a DNG without its JPEG is left alone (for now)');
    assert.equal(bg.status(FAKE_USER.id).rawStacks, 1);
    await bg.stop();
    store.close();
});

test('a second sign-in reuses the key; a revoked key is replaced', async () => {
    const { bg, store } = makeBackground();
    await bg.ensureUser(token, FAKE_USER.id);
    const count = fake.apiKeys.size;
    await bg.ensureUser(token, FAKE_USER.id);
    assert.equal(fake.apiKeys.size, count, 'reused');
    fake.apiKeys.clear();
    await bg.ensureUser(token, FAKE_USER.id);
    assert.equal(fake.apiKeys.size, 1, 'replaced');
    await bg.stop();
    store.close();
});

test('new uploads found by the poll get paired once both halves exist', async () => {
    const { bg, store, advance } = makeBackground({ config: { baseUrl: 'http://localhost:3024' } });
    await bg.ensureUser(token, FAKE_USER.id);
    assert.equal([...fake.workflows.values()].filter(w => w.steps[0].config.url.startsWith('http://localhost')).length, 0, 'no webhook for localhost');
    await bg.runOnce();
    const jpegId = addAsset('PXL_20261118_120000000.RAW-01.jpg', '2026-11-18T11:00:00.000Z');
    bg.enqueue(FAKE_USER.id, 'new-asset', jpegId);
    await bg.runOnce();
    assert.equal(fake.stackOf(jpegId), null, 'waits for the DNG');
    const rawId = addAsset('PXL_20261118_120000000.RAW-02.ORIGINAL.dng', '2026-11-18T11:00:00.000Z');
    advance(3 * 60 * 1000);
    bg.enqueue(FAKE_USER.id, 'new-asset', rawId);
    await bg.runOnce();
    assert.ok(fake.stackOf(jpegId)?.assetIds.includes(rawId));
    await bg.stop();
    store.close();
});

test('webhooks need the per-user secret', async () => {
    const { bg, store } = makeBackground();
    await bg.ensureUser(token, FAKE_USER.id);
    const secret = [...fake.workflows.values()].at(-1).steps[0].config.headerValue;
    assert.equal(bg.verifyWebhook(FAKE_USER.id, 'wrong'), false);
    assert.equal(bg.verifyWebhook('someone-else', secret), false);
    assert.equal(bg.verifyWebhook(FAKE_USER.id, secret), true);
    assert.equal(bg.onWebhook(FAKE_USER.id, { data: { asset: { id: randomUUID() } } }), true);
    assert.equal(bg.onWebhook(FAKE_USER.id, { data: {} }), false);
    await bg.stop();
    store.close();
});

test('unstacking only undoes stacks the app made, and stopping deletes key and webhook', async () => {
    const { bg, store } = makeBackground();
    const jpegId = addAsset('PXL_20260401_080000000.RAW-01.jpg', '2026-04-01T06:00:00.000Z');
    addAsset('PXL_20260401_080000000.RAW-02.ORIGINAL.dng', '2026-04-01T06:00:00.000Z');
    await bg.ensureUser(token, FAKE_USER.id);
    await bg.runOnce();
    await bg.runOnce();
    assert.ok(fake.stackOf(jpegId));
    const undone = await bg.unstackRawPairs(token, FAKE_USER.id);
    assert.ok(undone >= 1);
    assert.equal(fake.stackOf(jpegId), null);
    const keysBefore = fake.apiKeys.size;
    await bg.disableUser(token, FAKE_USER.id);
    assert.equal(bg.status(FAKE_USER.id).enabled, false);
    assert.equal(fake.apiKeys.size, keysBefore - 1, 'its own key is deleted');
    await bg.stop();
    store.close();
});
