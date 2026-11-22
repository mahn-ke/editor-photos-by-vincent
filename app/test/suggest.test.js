import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { createImmichClient } from '../src/immich.js';
import { createLearner } from '../src/learn.js';
import { pixelStats } from '../src/ml/grader.js';
import { armPriors, createSuggester } from '../src/suggest.js';
import { FAKE_USER, generateLibrary, startFakeImmich } from './fake-immich.js';
import { silentLog } from './helpers.js';

// Stand-in for CLIP: prefers brighter, moderately colourful images
const grader = {
    async score(img) {
        const s = pixelStats(img);
        let sum = 0;
        for (let j = 0; j < img.data.length; j++) sum += img.data[j];
        const mean = sum / img.data.length;
        const q = 0.5 + (0.5 - Math.abs(mean - 0.5)) * 0.4 + Math.min(s.colourfulness, 0.3) * 0.3;
        return { aesthetic: 4 + q, quality: q, beauty: q, natural: 0.6 - Math.max(0, s.colourfulness - 0.35), exposure: q, level: 0.5, ...s };
    },
    judge(base, cand) {
        const gain = (cand.aesthetic - base.aesthetic) * 2;
        return { improved: gain > 0.01 && cand.clipped - base.clipped <= 0.01, gain, reasons: [], aesthetic: gain };
    },
};

let fake, suggester, learner, clock;
before(async () => {
    fake = await startFakeImmich({ library: generateLibrary({ months: 1, now: new Date('2026-11-18T12:00:00Z') }) });
    const db = new DatabaseSync(':memory:');
    clock = Date.UTC(2026, 10, 18, 12);
    learner = createLearner({ db, priors: armPriors(), now: () => clock });
    suggester = createSuggester({ db, immich: createImmichClient({ baseUrl: fake.url }), grader, learner, dataDir: mkdtempSync(path.join(tmpdir(), 'ep-')), log: silentLog, now: () => clock });
    fake.tokens.add('t');
});
after(() => fake.close());

test('prepares previews for a new photo, shows them in the greeting, and learns from a dismissal', async () => {
    const photo = [...fake.assets.values()].find(a => a.isImage);
    photo.createdAt = new Date(clock - 3600e3).toISOString(); // uploaded an hour ago
    const outcome = await suggester.process(FAKE_USER.id, 't', photo.id);
    await suggester.prepareSubjects(FAKE_USER.id, 't');
    assert.match(outcome, /^suggested:[12]$/);
    assert.equal(await suggester.process(FAKE_USER.id, 't', photo.id), 'done-before', 'each photo is processed once');

    const greeting = suggester.greeting(FAKE_USER.id);
    assert.equal(greeting.window, '2 hours');
    assert.equal(greeting.text, 'Based on your uploads in the last 2 hours, here are some edits');
    const [item] = greeting.suggestions;
    assert.equal(item.assetId, photo.id);
    assert.ok(suggester.preview(FAKE_USER.id, item.id, 'before')?.length > 1000);
    assert.ok(suggester.preview(FAKE_USER.id, item.id, 'after')?.length > 1000);
    assert.equal(suggester.preview('someone-else', item.id, 'after'), null);

    assert.ok(suggester.dismiss(FAKE_USER.id, item.id));
    assert.ok(learner.summary(FAKE_USER.id).some(r => r.action === 'dismissed' && r.n === 1));
    assert.ok(!suggester.greeting(FAKE_USER.id).suggestions.some(s => s.id === item.id));
});

test('older uploads widen the greeting window', async () => {
    const photo = [...fake.assets.values()].filter(a => a.isImage)[1];
    photo.createdAt = new Date(clock - 2.5 * 24 * 3600e3).toISOString();
    for (const s of suggester.greeting(FAKE_USER.id).suggestions) suggester.dismiss(FAKE_USER.id, s.id);
    await suggester.process(FAKE_USER.id, 't', photo.id);
    await suggester.prepareSubjects(FAKE_USER.id, 't');
    assert.equal(suggester.greeting(FAKE_USER.id).window, '3 days');
});

test('accepting with tweaks teaches strength; edited photos and RAW halves are skipped', async () => {
    const photo = [...fake.assets.values()].filter(a => a.isImage)[2];
    photo.createdAt = new Date(clock - 3600e3).toISOString();
    await suggester.process(FAKE_USER.id, 't', photo.id);
    await suggester.prepareSubjects(FAKE_USER.id, 't');
    const item = suggester.greeting(FAKE_USER.id).suggestions.find(s => s.assetId === photo.id);
    const tweaked = { ...item.recipe, adjust: { ...item.recipe.adjust, pop: Math.min(1, item.recipe.adjust.pop + 0.3) } };
    suggester.accepted(FAKE_USER.id, item.id, tweaked);
    assert.ok(learner.summary(FAKE_USER.id).some(r => r.action === 'tweaked'));

    const edited = [...fake.assets.values()].filter(a => a.isImage)[3];
    fake.metadata.set(edited.id, new Map([['editor-photos', { v: 1, edits: [{ id: 'e' }] }]]));
    assert.equal(await suggester.process(FAKE_USER.id, 't', edited.id), 'already-edited');
    const raw = [...fake.assets.values()].filter(a => a.isImage)[4];
    raw.originalFileName = 'PXL_20261118_101010101.RAW-02.ORIGINAL.dng';
    assert.equal(await suggester.process(FAKE_USER.id, 't', raw.id), 'raw-half');
});
