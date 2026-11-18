import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createLearner, FEATURES } from '../src/learn.js';

const ARMS = ['learned-mono-contrast', 'learned-vivid', 'learned-enhance'];
const PRIORS = { 'learned-mono-contrast': 2 / 35, 'learned-vivid': 10 / 35, 'learned-enhance': 10 / 35 };

function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function photo(night, r) {
    const x = Object.fromEntries(FEATURES.map(k => [k, 0]));
    Object.assign(x, { bias: 1, p05: night ? 0.02 : 0.15, p50: night ? 0.12 + r() * 0.05 : 0.45 + r() * 0.1, p95: night ? 0.6 : 0.9, colourfulness: r() * 0.5, quality: 0.4 + r() * 0.2, exposure: 0.4, natural: 0.5, night: night ? 1 : 0 });
    return FEATURES.map(k => x[k]);
}

test('learns a hidden preference (B&W on night shots) faster than frequency alone', () => {
    const r = rng(42);
    const learner = createLearner({ db: new DatabaseSync(':memory:'), priors: PRIORS, random: r });
    let learnedHits = 0;
    let frequencyHits = 0;
    const rounds = 80;
    for (let i = 0; i < rounds; i++) {
        const night = r() < 0.4;
        const x = photo(night, r);
        const want = night ? 'learned-mono-contrast' : (r() < 0.5 ? 'learned-vivid' : 'learned-enhance');
        const ranked = learner.rank('u1', ARMS, x).sort((a, b) => b.sample - a.sample);
        const shown = ranked[0].arm;
        if (i >= 30) {
            const best = learner.rank('u1', ARMS, x, { explore: false }).sort((a, b) => b.expected - a.expected)[0].arm;
            if (night && best === want) learnedHits++;
            if (night && 'learned-vivid' === want) frequencyHits++; // frequency would always pick the most used look
        }
        learner.record('u1', { action: shown === want || (!night && shown !== 'learned-mono-contrast') ? 'applied' : 'dismissed', arm: shown, x });
    }
    assert.ok(learnedHits > frequencyHits, `${learnedHits} vs ${frequencyHits}`);
    const night = learner.rank('u1', ARMS, photo(true, r), { explore: false }).sort((a, b) => b.expected - a.expected)[0].arm;
    const day = learner.rank('u1', ARMS, photo(false, r), { explore: false }).sort((a, b) => b.expected - a.expected)[0].arm;
    assert.equal(night, 'learned-mono-contrast');
    assert.notEqual(day, 'learned-mono-contrast');
});

test('repeated tweaks shift the predicted strength', () => {
    const r = rng(1);
    const learner = createLearner({ db: new DatabaseSync(':memory:'), priors: PRIORS, random: r });
    const x = photo(false, r);
    assert.deepEqual(learner.strengthOffsets('u1', x), {});
    for (let i = 0; i < 12; i++) learner.record('u1', { action: 'tweaked', arm: 'learned-vivid', x: photo(false, r), detail: { delta: { pop: 0.2 } } });
    const pop = learner.strengthOffsets('u1', x).pop;
    assert.ok(pop > 0.12 && pop < 0.25, String(pop));
});

test('pairwise choices teach the personal preference', () => {
    const learner = createLearner({ db: new DatabaseSync(':memory:'), priors: PRIORS });
    const x = photo(false, rng(3));
    const saturated = { aesthetic: 5.2, colourfulness: 0.4 };
    const subtle = { aesthetic: 5.0, colourfulness: 0.15 };
    for (let i = 0; i < 20; i++) learner.record('u1', { action: 'dismissed', arm: 'learned-vivid', x, detail: { pair: { winner: subtle, loser: saturated } } });
    assert.ok(learner.preference('u1', { colourfulness: 0.25, aesthetic: 0.2 }) < 0, 'more colourful is now penalised');
});

test('reset returns to the Google Photos starting values, and users stay separate', () => {
    const r = rng(5);
    const learner = createLearner({ db: new DatabaseSync(':memory:'), priors: PRIORS, random: r });
    const x = photo(false, r);
    const before = learner.rank('u1', ARMS, x, { explore: false });
    for (let i = 0; i < 15; i++) learner.record('u1', { action: 'dismissed', arm: 'learned-vivid', x });
    const after = learner.rank('u1', ARMS, x, { explore: false }).find(a => a.arm === 'learned-vivid');
    assert.ok(after.expected < before.find(a => a.arm === 'learned-vivid').expected);
    const other = learner.rank('u2', ARMS, x, { explore: false }).find(a => a.arm === 'learned-vivid');
    assert.equal(other.expected, before.find(a => a.arm === 'learned-vivid').expected, 'u2 unaffected');
    learner.reset('u1');
    const reset = learner.rank('u1', ARMS, x, { explore: false }).find(a => a.arm === 'learned-vivid');
    assert.equal(reset.expected, before.find(a => a.arm === 'learned-vivid').expected);
    const replay = learner.replay('u1');
    assert.ok(replay.events >= 15);
});
