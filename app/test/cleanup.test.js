import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { createImmichClient } from '../src/immich.js';
import { createLearner } from '../src/learn.js';
import { pixelStats } from '../src/ml/grader.js';
import { createAnnouncer, createNotifier, suggestionsMessage } from '../src/notify.js';
import { armPriors, createSuggester } from '../src/suggest.js';
import { FAKE_USER, generateLibrary, startFakeImmich } from './fake-immich.js';
import { silentLog } from './helpers.js';

// A grader under which no edit ever helps: every photo ends up without a suggestion
const grader = {
    async score(img) {
        return { aesthetic: 5, quality: 0.5, ...pixelStats(img) };
    },
    judge: () => ({ improved: false, gain: 0, reasons: [], aesthetic: 0 }),
};

let fake, suggester, clock, db;
before(async () => {
    fake = await startFakeImmich({ library: generateLibrary({ months: 1, now: new Date('2026-11-18T12:00:00Z') }) });
    db = new DatabaseSync(':memory:');
    clock = Date.UTC(2026, 10, 18, 12);
    const learner = createLearner({ db, priors: armPriors(), now: () => clock });
    suggester = createSuggester({ db, immich: createImmichClient({ baseUrl: fake.url }), grader, learner, dataDir: mkdtempSync(path.join(tmpdir(), 'ep-')), log: silentLog, now: () => clock });
    fake.tokens.add('t');
});
after(() => fake.close());

// Photos not processed by an earlier test
const photos = () => [...fake.assets.values()].filter(a => a.isImage && !a.isTrashed && !fake.stackOf(a.id)
    && !db.prepare('SELECT 1 FROM suggestion_assets WHERE asset_id = ?').get(a.id));

test('photos without a suggestion become one cleanup card; Apply trashes the ticked ones with their RAW twin', async () => {
    const [plain, paired, kept] = photos();
    const raw = [...fake.assets.values()].find(a => a.isImage && a.id !== plain.id && a.id !== paired.id && a.id !== kept.id && !fake.stackOf(a.id));
    fake.stacks.set('st-pair', { id: 'st-pair', primaryAssetId: paired.id, assetIds: [paired.id, raw.id] });

    for (const p of [plain, paired, kept]) assert.equal(await suggester.process(FAKE_USER.id, 't', p.id), 'no-improvement');
    const greeting = suggester.greeting(FAKE_USER.id);
    assert.deepEqual(greeting.suggestions, []);
    assert.equal(greeting.cleanup.count, 3);
    assert.equal(greeting.cleanup.previewIds.length, 3);

    const candidates = await suggester.cleanupCandidates(FAKE_USER.id, 't');
    assert.deepEqual(new Set(candidates), new Set([plain.id, paired.id, kept.id]));

    // An id that was never offered is ignored; `kept` was unticked
    const result = await suggester.applyCleanup(FAKE_USER.id, 't', [plain.id, paired.id, 'not-offered']);
    assert.deepEqual(result, { trashed: 2, assets: 3 });
    assert.ok(plain.isTrashed && paired.isTrashed && raw.isTrashed, 'the RAW twin goes with its JPEG');
    assert.ok(!kept.isTrashed);
    assert.equal(suggester.greeting(FAKE_USER.id).cleanup, null, 'unticked photos are not offered again');
});

test('edited, trashed and dismissed candidates drop out; screenshots and videos are never offered', async () => {
    const [a, b, c, shot] = photos();
    for (const p of [a, b, c]) await suggester.process(FAKE_USER.id, 't', p.id);
    shot.originalFileName = 'Screenshot_20261118.png';
    assert.equal(await suggester.process(FAKE_USER.id, 't', shot.id), 'screenshot');
    assert.equal(suggester.greeting(FAKE_USER.id).cleanup.count, 3);

    suggester.manualEdit(FAKE_USER.id, a.id, {});
    b.isTrashed = true;
    assert.deepEqual(await suggester.cleanupCandidates(FAKE_USER.id, 't'), [c.id]);
    suggester.dismissCleanup(FAKE_USER.id);
    assert.equal(suggester.greeting(FAKE_USER.id).cleanup, null);
});

test('one notification per settled batch, counting suggestion cards and the cleanup card', async () => {
    const sent = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            sent.push({ key: req.headers['x-gotify-key'], url: req.url, body: JSON.parse(body) });
            res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const notifier = createNotifier({ url: `http://127.0.0.1:${server.address().port}`, token: 'app-token', log: silentLog });
        const announce = createAnnouncer({ suggester, notifier, baseUrl: 'https://editor.example', log: silentLog });
        const [photo] = photos();
        await suggester.process(FAKE_USER.id, 't', photo.id); // a new cleanup candidate
        // …and three suggestions with their subjects prepared: two cards
        const insert = db.prepare(`INSERT INTO suggestions (id, user_id, asset_id, uploaded_at, computed_at, status, arm, name, recipe, why, gain, features, scores, rank, embedding, subject_at)
            VALUES (?, ?, ?, ?, ?, 'ready', 'a', 'Look', '{}', '', 0.3, '[]', '{}', 0, ?, 1)`);
        insert.run('n1', FAKE_USER.id, 'food-1', clock - 3600e3, clock, JSON.stringify([1, 0, 0]));
        insert.run('n2', FAKE_USER.id, 'food-2', clock - 3600e3, clock, JSON.stringify([0.99, 0.1, 0])); // same subject
        insert.run('n3', FAKE_USER.id, 'skyline', clock - 3600e3, clock, JSON.stringify([0, 1, 0]));

        assert.equal(await announce(FAKE_USER.id, { suggest: 2, subjects: 1 }), 'busy', 'waits for the batch to settle');
        assert.equal(sent.length, 0);
        assert.equal(await announce(FAKE_USER.id, { subjects: 1, poll: 1 }), 'sent');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].url, '/message');
        assert.equal(sent[0].key, 'app-token');
        assert.equal(sent[0].body.message, '3 new photo suggestions - Tap to open and review!');
        assert.equal(sent[0].body.extras['client::notification'].click.url, 'https://editor.example/');

        assert.equal(await announce(FAKE_USER.id, {}), 'nothing', 'each suggestion is announced once');
        assert.equal(sent.length, 1);
        assert.equal(suggestionsMessage(1), '1 new photo suggestion - Tap to open and review!');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('without a Gotify token nothing is sent, and old suggestions are not announced later', async () => {
    const insert = db.prepare(`INSERT INTO suggestions (id, user_id, asset_id, uploaded_at, computed_at, status, arm, name, recipe, why, gain, features, scores, rank, subject_at)
        VALUES ('q1', ?, 'quiet', ?, ?, 'ready', 'a', 'Look', '{}', '', 0.3, '[]', '{}', 0, 1)`);
    insert.run(FAKE_USER.id, clock - 3600e3, clock);
    const announce = createAnnouncer({ suggester, notifier: createNotifier({ url: 'http://unused', token: '' }), baseUrl: 'https://editor.example', log: silentLog });
    assert.equal(await announce(FAKE_USER.id, {}), 'disabled');
    assert.equal(suggester.pendingNotification(FAKE_USER.id).count, 0);
});
