// Per-user learning from how you react to suggestions and how you edit:
// - which preset to suggest: linear Thompson sampling, one arm per preset/combination
// - how strong: online ridge regression of your slider tweaks
// - your taste: pairwise logistic preference over grader scores
// State lives in SQLite, versioned per user (last 5 snapshots kept).

import { ADJUST_KEYS } from '../public/edit/recipe.js';

export const FEATURES = ['bias', 'p05', 'p50', 'p95', 'colourfulness', 'clipped', 'tiltConfidence', 'tiltSize', 'quality', 'exposure', 'natural', 'night'];
const D = FEATURES.length;
const SCORE_KEYS = ['aesthetic', 'quality', 'beauty', 'natural', 'exposure', 'colourfulness', 'clipped'];
export const REWARDS = { applied: 1, tweaked: 0.7, dismissed: -1, ignored: -0.2, discarded: -0.8, similarManual: 0.5, unrelatedManual: -0.1 };

export function featuresOf({ stats, base, tilt }) {
    const f = {
        bias: 1,
        p05: stats.p05, p50: stats.p50, p95: stats.p95,
        colourfulness: Math.min(1, base.colourfulness * 3), clipped: Math.min(1, base.clipped * 10),
        tiltConfidence: tilt.confidence, tiltSize: Math.min(1, Math.abs(tilt.angle) / 8),
        quality: base.quality, exposure: base.exposure, natural: base.natural,
        night: stats.p50 < 0.22 ? 1 : 0,
    };
    return FEATURES.map(k => f[k] ?? 0);
}

// ---- small dense linear algebra (D ≤ 12) ----
const identity = (n, s = 1) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? s : 0)));
function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        [M[c], M[p]] = [M[p], M[c]];
        const pivot = M[c][c] || 1e-9;
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = M[r][c] / pivot;
            for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
        }
    }
    return M.map((row, i) => row[n] / (row[i] || 1e-9));
}
function cholesky(A) {
    const n = A.length;
    const L = identity(n, 0);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = A[i][j];
            for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
            L[i][j] = i === j ? Math.sqrt(Math.max(sum, 1e-12)) : sum / L[j][j];
        }
    }
    return L;
}
function inverse(A) {
    const n = A.length;
    return identity(n).map(col => solve(A, col)).reduce((inv, col, j) => {
        col.forEach((v, i) => { inv[i][j] = v; });
        return inv;
    }, identity(n, 0));
}
function gaussian(rand) {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function newArm(prior = 0) {
    // Prior: as if we had seen `prior` reward on 3 average photos (intercept only)
    const A = identity(D, 1);
    const b = new Array(D).fill(0);
    A[0][0] += 3;
    b[0] += 3 * prior;
    return { A, b, n: 0 };
}

export function createLearner({ db, priors = {}, now = Date.now, random = Math.random }) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS learner_models (
            user_id TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, version)
        );
        CREATE TABLE IF NOT EXISTS feedback_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, asset_id TEXT, arm TEXT, action TEXT NOT NULL,
            reward REAL, features TEXT, detail TEXT, created_at INTEGER NOT NULL
        );
    `);
    const q = {
        latest: db.prepare('SELECT * FROM learner_models WHERE user_id = ? ORDER BY version DESC LIMIT 1'),
        save: db.prepare('INSERT INTO learner_models (user_id, version, state, created_at) VALUES (?, ?, ?, ?)'),
        prune: db.prepare('DELETE FROM learner_models WHERE user_id = ? AND version <= ?'),
        reset: db.prepare('DELETE FROM learner_models WHERE user_id = ?'),
        event: db.prepare('INSERT INTO feedback_events (user_id, asset_id, arm, action, reward, features, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
        events: db.prepare('SELECT * FROM feedback_events WHERE user_id = ? ORDER BY id'),
        counts: db.prepare('SELECT arm, action, COUNT(*) AS n FROM feedback_events WHERE user_id = ? GROUP BY arm, action'),
    };

    function fresh() {
        return {
            arms: Object.fromEntries(Object.entries(priors).map(([arm, share]) => [arm, newArm((share - 0.15) * 2)])),
            strength: Object.fromEntries(ADJUST_KEYS.map(k => [k, { A: identity(D, 4), b: new Array(D).fill(0), n: 0 }])),
            preference: { w: new Array(SCORE_KEYS.length).fill(0), n: 0 },
        };
    }

    function load(userId) {
        const row = q.latest.get(userId);
        return row ? { version: row.version, state: JSON.parse(row.state) } : { version: 0, state: fresh() };
    }

    function store(userId, version, state) {
        q.save.run(userId, version + 1, JSON.stringify(state), now());
        q.prune.run(userId, version + 1 - 5);
    }

    function arm(state, name) {
        if (!state.arms[name]) state.arms[name] = newArm(priors[name] !== undefined ? (priors[name] - 0.15) * 2 : 0);
        return state.arms[name];
    }

    // Expected reward (mean) and a Thompson sample for each candidate arm
    function rank(userId, armNames, x, { explore = true } = {}) {
        const { state } = load(userId);
        return armNames.map((name) => {
            const a = arm(state, name);
            const mean = solve(a.A, a.b);
            const expected = mean.reduce((s, m, i) => s + m * x[i], 0);
            let sample = expected;
            if (explore) {
                const L = cholesky(inverse(a.A));
                const z = Array.from({ length: D }, () => gaussian(random));
                const theta = mean.map((m, i) => m + 0.5 * L[i].reduce((s, l, k) => s + l * z[k], 0));
                sample = theta.reduce((s, t, i) => s + t * x[i], 0);
            }
            return { arm: name, expected, sample, observations: a.n };
        });
    }

    // Personal adjustment of a grader verdict from pairwise choices
    function preference(userId, deltaScores) {
        const { state } = load(userId);
        return SCORE_KEYS.reduce((s, k, i) => s + state.preference.w[i] * (deltaScores[k] ?? 0), 0);
    }

    // Predicted slider offsets for this photo (your usual tweaks)
    function strengthOffsets(userId, x) {
        const { state } = load(userId);
        const out = {};
        for (const key of ADJUST_KEYS) {
            const m = state.strength[key];
            if (!m?.n) continue;
            const w = solve(m.A, m.b);
            const v = w.reduce((s, wi, i) => s + wi * x[i], 0);
            if (Math.abs(v) >= 0.02) out[key] = Math.max(-0.5, Math.min(0.5, v));
        }
        return out;
    }

    function record(userId, { action, arm: armName = null, assetId = null, x = null, detail = null, reward = REWARDS[action] }) {
        q.event.run(userId, assetId, armName, action, reward ?? null, x ? JSON.stringify(x) : null, detail ? JSON.stringify(detail) : null, now());
        if (!x) return;
        const { version, state } = load(userId);
        if (armName && reward !== undefined && reward !== null) {
            const a = arm(state, armName);
            for (let i = 0; i < D; i++) {
                for (let j = 0; j < D; j++) a.A[i][j] += x[i] * x[j];
                a.b[i] += reward * x[i];
            }
            a.n++;
        }
        // Tweaks: final minus suggested slider values train the strength model
        if (detail?.delta) {
            for (const [key, delta] of Object.entries(detail.delta)) {
                const m = state.strength[key];
                if (!m || !Number.isFinite(delta)) continue;
                for (let i = 0; i < D; i++) {
                    for (let j = 0; j < D; j++) m.A[i][j] += x[i] * x[j];
                    m.b[i] += delta * x[i];
                }
                m.n++;
            }
        }
        // Pairs: winner's scores minus loser's scores, logistic step
        if (detail?.pair) {
            const diff = SCORE_KEYS.map(k => (detail.pair.winner[k] ?? 0) - (detail.pair.loser[k] ?? 0));
            const p = 1 / (1 + Math.exp(-diff.reduce((s, d, i) => s + d * state.preference.w[i], 0)));
            state.preference.w = state.preference.w.map((w, i) => w + 0.5 * (1 - p) * diff[i] - 0.001 * w);
            state.preference.n++;
        }
        store(userId, version, state);
    }

    function reset(userId) {
        q.reset.run(userId);
    }

    // Offline replay: how often the top-ranked arm was the one you accepted, vs. frequency only
    function replay(userId) {
        const events = q.events.all(userId).filter(e => e.features && e.arm && (e.action === 'applied' || e.action === 'tweaked' || e.action === 'dismissed'));
        if (!events.length) return { events: 0 };
        const temp = createLearner({ db: memoryDb(), priors, now, random: () => 0.5 });
        let hits = 0, baseline = 0, trials = 0;
        const arms = [...new Set(events.map(e => e.arm))];
        const freq = Object.fromEntries(arms.map(a => [a, priors[a] ?? 0]));
        for (const e of events) {
            const x = JSON.parse(e.features);
            if (e.action !== 'dismissed') {
                trials++;
                const ranked = temp.rank('replay', arms, x, { explore: false }).sort((a, b) => b.expected - a.expected);
                if (ranked[0].arm === e.arm) hits++;
                const byFreq = [...arms].sort((a, b) => freq[b] - freq[a]);
                if (byFreq[0] === e.arm) baseline++;
                freq[e.arm] = (freq[e.arm] ?? 0) + 1;
            }
            temp.record('replay', { action: e.action, arm: e.arm, x, reward: e.reward });
        }
        return { events: events.length, accepted: trials, learnerHitRate: trials ? hits / trials : 0, frequencyHitRate: trials ? baseline / trials : 0 };
    }

    function summary(userId) {
        return q.counts.all(userId);
    }

    return { rank, preference, strengthOffsets, record, reset, replay, summary, featuresOf };
}

let DatabaseSync;
function memoryDb() {
    return new DatabaseSync(':memory:');
}
export async function initLearnerRuntime() {
    ({ DatabaseSync } = await import('node:sqlite'));
}
await initLearnerRuntime();
