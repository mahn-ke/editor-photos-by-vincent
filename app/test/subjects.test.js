import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createLearner } from '../src/learn.js';
import { armPriors, createSuggester } from '../src/suggest.js';

test('the greeting shows one suggestion per subject: the best edit of the most interesting photo', () => {
    const db = new DatabaseSync(':memory:');
    const now = Date.UTC(2026, 10, 18, 12);
    const suggester = createSuggester({ db, immich: {}, grader: {}, learner: createLearner({ db, priors: armPriors() }), dataDir: mkdtempSync(path.join(tmpdir(), 'ep-')), now: () => now });
    const insert = db.prepare(`INSERT INTO suggestions (id, user_id, asset_id, uploaded_at, computed_at, status, arm, name, recipe, why, gain, features, scores, rank, embedding)
        VALUES (?, 'u', ?, ?, ?, 'ready', 'a', ?, '{}', '', ?, '[]', ?, 0, ?)`);
    const food = [1, 0, 0];
    const foodAgain = [0.98, 0.2, 0];
    const skyline = [0, 1, 0];
    const sauce = [0, 0, 1];
    const s = aesthetic => JSON.stringify({ base: { aesthetic }, candidate: {} });
    insert.run('f1', 'food-1', now - 3600e3, now, 'Vivid look', 0.5, s(5.5), JSON.stringify(food));
    insert.run('f2', 'food-2', now - 3600e3, now, 'Deep blue sky', 0.3, s(5.5), JSON.stringify(foodAgain));
    insert.run('f3', 'food-1', now - 3600e3, now, 'Gentle enhance', 0.2, s(5.5), JSON.stringify(food));
    insert.run('k1', 'skyline', now - 3600e3, now, 'Deep blue sky', 0.3, s(6.4), JSON.stringify(skyline));
    insert.run('c1', 'sauce', now - 3600e3, now, 'Warm lift', 0.45, s(4.0), JSON.stringify(sauce));
    const g = suggester.greeting('u');
    assert.deepEqual(g.suggestions.map(x => x.id), ['k1', 'f1', 'c1'], 'one card per subject, striking photos first, mundane last');
});

test('a suggestion\'s subject: similar photos taken around the same time, one per stack, no RAW halves', async () => {
    const db = new DatabaseSync(':memory:');
    const now = Date.UTC(2026, 10, 18, 12);
    const taken = '2026-11-17T21:10:00.000Z';
    const assets = {
        sky: { type: 'IMAGE', fileCreatedAt: taken, stack: { id: 'st-sky', primaryAssetId: 'sky' } },
        'sky-raw': { type: 'IMAGE', fileCreatedAt: taken, originalFileName: 'PXL_1.RAW-01.dng', stack: { id: 'st-sky', primaryAssetId: 'sky' } },
        'sky-2': { type: 'IMAGE', fileCreatedAt: taken, stack: { id: 'st-2', primaryAssetId: 'sky-2' } },
        'sky-2-raw': { type: 'IMAGE', fileCreatedAt: taken, stack: { id: 'st-2', primaryAssetId: 'sky-2' } },
        'sky-3': { type: 'IMAGE', fileCreatedAt: taken },
        'sky-trashed': { type: 'IMAGE', fileCreatedAt: taken, isTrashed: true },
        'sky-partner': { type: 'IMAGE', fileCreatedAt: taken, ownerId: 'partner' },
        gym: { type: 'IMAGE', fileCreatedAt: taken },
    };
    const immich = {
        asset: async (auth, id) => ({ id, ...assets[id] }),
        stack: async (auth, id) => ({ id, assets: Object.keys(assets).filter(a => assets[a].stack?.id === id).map(a => ({ id: a })) }),
        searchMetadata: async (auth, body) => {
            assert.ok(body.takenAfter < taken && body.takenBefore > taken, 'searches around the capture time');
            return { items: Object.keys(assets).map(id => ({ id, ownerId: assets[id].ownerId ?? 'u' })) };
        },
    };
    const suggester = createSuggester({ db, immich, grader: {}, learner: createLearner({ db, priors: armPriors() }), dataDir: mkdtempSync(path.join(tmpdir(), 'ep-')), now: () => now });
    db.prepare(`INSERT INTO suggestions (id, user_id, asset_id, uploaded_at, computed_at, status, arm, name, recipe, why, gain, features, scores, rank, embedding)
        VALUES ('s1', 'u', 'sky', ?, ?, 'ready', 'a', 'Deep blue sky', '{}', '', 0.3, '[]', '{}', 0, ?)`).run(now - 3600e3, now, JSON.stringify([1, 0, 0]));
    // Embeddings the background job stored for photos that got no suggestion of their own
    const embed = db.prepare('INSERT INTO asset_embeddings (user_id, asset_id, embedding) VALUES (\'u\', ?, ?)');
    for (const [id, e] of [['sky-2', [0.98, 0.2, 0]], ['sky-2-raw', [1, 0, 0]], ['sky-3', [0.97, 0.24, 0]], ['sky-trashed', [1, 0, 0]], ['sky-partner', [1, 0, 0]], ['gym', [0, 1, 0]]]) embed.run(id, JSON.stringify(e));
    const ids = await suggester.subject('u', 't', 's1');
    assert.deepEqual(ids.sort(), ['sky-2', 'sky-3']);
    assert.deepEqual(suggester.shownSubject('u', 's1').sort(), ['sky-2', 'sky-3'], 'remembered for the apply');
    assert.deepEqual(suggester.shownSubject('other', 's1'), []);
});
