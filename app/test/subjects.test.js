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

test('a suggestion\'s subject lists the other photos folded into it, and retired photos drop out', () => {
    const db = new DatabaseSync(':memory:');
    const now = Date.UTC(2026, 10, 18, 12);
    const suggester = createSuggester({ db, immich: {}, grader: {}, learner: createLearner({ db, priors: armPriors() }), dataDir: mkdtempSync(path.join(tmpdir(), 'ep-')), now: () => now });
    const insert = db.prepare(`INSERT INTO suggestions (id, user_id, asset_id, uploaded_at, computed_at, status, arm, name, recipe, why, gain, features, scores, rank, embedding)
        VALUES (?, ?, ?, ?, ?, 'ready', 'a', 'Vivid', '{}', '', 0.3, '[]', '{}', 0, ?)`);
    const e = v => JSON.stringify(v);
    insert.run('a1', 'u', 'food-1', now - 3600e3, now, e([1, 0, 0]));
    insert.run('a2', 'u', 'food-1', now - 3600e3, now, e([1, 0, 0]));
    insert.run('b1', 'u', 'food-2', now - 3600e3, now, e([0.98, 0.2, 0]));
    insert.run('c1', 'u', 'food-3', now - 3600e3, now, e([0.97, 0.24, 0]));
    insert.run('d1', 'u', 'skyline', now - 3600e3, now, e([0, 1, 0]));
    insert.run('x1', 'other-user', 'food-x', now - 3600e3, now, e([1, 0, 0]));
    assert.deepEqual(suggester.subject('u', 'a1').sort(), ['food-2', 'food-3']);
    assert.deepEqual(suggester.subject('u', 'd1'), []);
    assert.deepEqual(suggester.subject('other-user', 'a1'), [], 'only your own suggestions');
    suggester.retire('u', ['food-2']);
    assert.deepEqual(suggester.subject('u', 'a1'), ['food-3']);
});
