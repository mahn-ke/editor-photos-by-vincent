// Edit suggestions for new uploads, prepared in the background.
// For each photo: try your learned looks, per-photo Enhance/Dynamic and Straighten (alone
// and combined), keep only candidates the grader says improve the photo, rank them with
// your learner, and store the best one or two with before/after previews.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { autoRecipes, measure } from '../public/edit/auto.js';
import { FILTERS } from '../public/edit/filters.js';
import { detectTilt } from '../public/edit/horizon.js';
import { LEARNED_PRESETS, STRAIGHTEN } from '../public/edit/learned-presets.js';
import { applyTone, fromRGB, render, resize, toRGB8 } from '../public/edit/pipeline.js';
import { ADJUST_KEYS, describeRecipe, normalizeRecipe } from '../public/edit/recipe.js';
import { EDITS_KEY, RENDER_KEY } from './edits.js';
import { FEATURES, featuresOf, REWARDS } from './learn.js';

const FEATURES_NIGHT = FEATURES.indexOf('night');
import { pairKey } from './raw-pairs.js';

const WINDOWS = [
    [2 * 3600e3, '2 hours'], [24 * 3600e3, 'day'], [3 * 24 * 3600e3, '3 days'],
    [7 * 24 * 3600e3, 'week'], [28 * 24 * 3600e3, '4 weeks'],
];
const WORK_SIZE = 768;
const KEEP = 2;

export function armPriors() {
    const priors = Object.fromEntries(LEARNED_PRESETS.map(p => [p.id, p.share]));
    priors.enhance = 0.2;
    priors.dynamic = 0.1;
    priors.neon = 0.08;
    priors.straighten = STRAIGHTEN.share;
    for (const p of LEARNED_PRESETS) priors[`straighten+${p.id}`] = Math.min(p.share, STRAIGHTEN.share);
    return priors;
}

function mergeAdjust(...parts) {
    const out = {};
    for (const part of parts) for (const [k, v] of Object.entries(part ?? {})) out[k] = Math.max(-1, Math.min(1, (out[k] ?? 0) + v));
    return out;
}

export function createSuggester({ db, immich, grader, learner, dataDir, log = console, now = Date.now }) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS suggestions (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, asset_id TEXT NOT NULL, uploaded_at INTEGER NOT NULL,
            computed_at INTEGER NOT NULL, status TEXT NOT NULL, arm TEXT, name TEXT, recipe TEXT, why TEXT,
            gain REAL, features TEXT, scores TEXT, shown_at INTEGER, rank INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS suggestions_user ON suggestions (user_id, status, uploaded_at);
        CREATE TABLE IF NOT EXISTS suggestion_assets (
            user_id TEXT NOT NULL, asset_id TEXT NOT NULL, processed_at INTEGER NOT NULL, outcome TEXT,
            PRIMARY KEY (user_id, asset_id)
        );
    `);
    try {
        db.exec('ALTER TABLE suggestions ADD COLUMN embedding TEXT');
    } catch {
        // column exists already
    }
    const q = {
        setEmbedding: db.prepare('UPDATE suggestions SET embedding = ? WHERE id = ?'),
        processed: db.prepare('SELECT 1 FROM suggestion_assets WHERE user_id = ? AND asset_id = ?'),
        markProcessed: db.prepare('INSERT OR REPLACE INTO suggestion_assets (user_id, asset_id, processed_at, outcome) VALUES (?, ?, ?, ?)'),
        insert: db.prepare(`INSERT INTO suggestions (id, user_id, asset_id, uploaded_at, computed_at, status, arm, name, recipe, why, gain, features, scores, rank)
            VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)`),
        ready: db.prepare("SELECT * FROM suggestions WHERE user_id = ? AND status = 'ready' AND uploaded_at >= ? ORDER BY rank, gain DESC, uploaded_at DESC"),
        get: db.prepare('SELECT * FROM suggestions WHERE id = ? AND user_id = ?'),
        setStatus: db.prepare('UPDATE suggestions SET status = ? WHERE id = ?'),
        siblings: db.prepare("UPDATE suggestions SET status = 'superseded' WHERE user_id = ? AND asset_id = ? AND id != ? AND status = 'ready'"),
        shown: db.prepare('UPDATE suggestions SET shown_at = ? WHERE id = ? AND shown_at IS NULL'),
        stale: db.prepare("SELECT * FROM suggestions WHERE status = 'ready' AND shown_at IS NOT NULL AND shown_at < ?"),
        forAsset: db.prepare("SELECT * FROM suggestions WHERE user_id = ? AND asset_id = ? AND status IN ('ready', 'applying')"),
    };
    const previewDir = path.join(dataDir === ':memory:' ? path.join(process.cwd(), 'data') : dataDir, 'suggestions');
    mkdirSync(previewDir, { recursive: true });
    const previewFile = (id, which) => path.join(previewDir, `${id}-${which}.jpg`);

    async function loadPreview(auth, assetId) {
        const response = await immich.media(auth, assetId, 'preview');
        if (!response.ok) throw new Error(`preview ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const { data, info } = await sharp(bytes).autoOrient().removeAlpha().resize({ width: 1440, height: 1440, fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
        return fromRGB(data, info.width, info.height);
    }

    async function writeJpeg(img, file) {
        await sharp(Buffer.from(toRGB8(img).buffer), { raw: { width: img.width, height: img.height, channels: 3 } }).jpeg({ quality: 85 }).toFile(file);
    }

    function candidateRecipes(stats, tilt, userId, x, base = {}) {
        const offsets = learner.strengthOffsets(userId, x);
        const list = [];
        const autos = autoRecipes(stats);
        list.push({ arm: 'enhance', name: 'Enhance', recipe: { adjust: autos.enhance.adjust } });
        list.push({ arm: 'dynamic', name: 'Dynamic', recipe: { adjust: autos.dynamic.adjust } });
        // Neon night: teal shadows, magenta highlights, deep blues (offered for city/night scenes)
        if ((x[FEATURES_NIGHT] ?? 0) || (base.night ?? 0) > 0.5 || stats.p50 < 0.3) list.push({ arm: 'neon', name: 'Neon night', recipe: { filter: { id: 'neon', strength: 1 } } });
        for (const p of LEARNED_PRESETS) {
            const adjust = mergeAdjust(p.recipe.adjust, Object.fromEntries(Object.entries(offsets).filter(([k]) => k in (p.recipe.adjust ?? {}))));
            list.push({ arm: p.id, name: p.name, recipe: { adjust, filter: p.recipe.filter ?? { id: 'none', strength: 1 } }, mono: p.recipe.adjust.saturation === -1 || FILTERS[p.recipe.filter?.id]?.mono });
        }
        return list.map(c => ({ ...c, recipe: normalizeRecipe(c.recipe) }));
    }

    async function process(userId, auth, assetId) {
        if (q.processed.get(userId, assetId)) return 'done-before';
        const asset = await immich.asset(auth, assetId);
        const skip = (outcome) => {
            q.markProcessed.run(userId, assetId, now(), outcome);
            return outcome;
        };
        if (asset.type !== 'IMAGE' || asset.isTrashed) return skip('not-a-photo');
        if (/\.dng$/i.test(asset.originalFileName ?? '') && pairKey(asset.originalFileName)?.part === 'raw') return skip('raw-half');
        const meta = await immich.metadata(auth, assetId);
        if (meta[RENDER_KEY] || meta[EDITS_KEY]) return skip('already-edited');
        // Screenshots and photos of screens aren't worth suggesting edits for
        if (/^(screenshot|screen_?shot|scr_)/i.test(asset.originalFileName ?? '') || (/png$/i.test(asset.originalMimeType ?? '') && !asset.exifInfo?.make)) return skip('screenshot');

        const full = await loadPreview(auth, assetId);
        const scale = Math.min(1, WORK_SIZE / Math.max(full.width, full.height));
        const work = resize(full, Math.round(full.width * scale), Math.round(full.height * scale));
        const stats = measure(work);
        const tilt = detectTilt(full);
        const base = await grader.score(work);
        if (base.screen > 0.6) return skip('screen');
        const x = featuresOf({ stats, base, tilt });

        // 1. Looks on the photo as it is
        const looks = [];
        for (const c of candidateRecipes(stats, tilt, userId, x, base)) {
            const img = applyTone({ ...work, data: Float32Array.from(work.data) }, c.recipe);
            const s = await grader.score(img);
            const verdict = grader.judge(base, s, { mono: c.mono });
            const personal = learner.preference(userId, Object.fromEntries(Object.keys(s).map(k => [k, s[k] - base[k]])));
            looks.push({ ...c, scores: s, verdict, gain: verdict.gain + personal });
        }

        if (globalThis.process.env.SUGGEST_DEBUG) {
            log.info?.(`Suggest ${assetId}: tilt ${JSON.stringify(tilt)} base aesthetic ${base.aesthetic.toFixed(2)} quality ${base.quality.toFixed(2)}`);
            for (const l of looks) log.info?.(`  ${l.arm}: gain ${l.gain.toFixed(3)} aesthetic ${l.verdict.aesthetic} prompts ${l.verdict.prompts} ${l.verdict.reasons.join('; ')}`);
        }
        // 2. Straighten, trusted from the horizon detector (CLIP can't judge levelness)
        const candidates = looks.filter(l => l.verdict.improved);
        const straightenOk = tilt.confidence >= 0.5 && Math.abs(tilt.angle) >= 0.4 && Math.abs(tilt.angle) <= STRAIGHTEN.maxAngle;
        if (straightenOk) {
            const geometry = { angle: tilt.angle };
            candidates.push({ arm: 'straighten', name: 'Straighten', recipe: normalizeRecipe({ geometry }), gain: 0.05 + tilt.confidence * 0.1 * Math.min(1, Math.abs(tilt.angle) / 2), scores: base, verdict: { improved: true, reasons: [] } });
            for (const look of candidates.filter(c => c.arm !== 'straighten' && c.arm !== 'enhance' && c.arm !== 'dynamic').slice(0, 3)) {
                candidates.push({
                    arm: `straighten+${look.arm}`, name: `Straighten + ${look.name}`,
                    recipe: normalizeRecipe({ ...look.recipe, geometry }), gain: look.gain + 0.08, scores: look.scores, verdict: look.verdict,
                });
            }
        }
        if (!candidates.length) return skip('no-improvement');

        // 3. Rank: grader gain plus what you tend to accept (Thompson sample = some exploration)
        const ranked = learner.rank(userId, candidates.map(c => c.arm), x);
        const byArm = Object.fromEntries(ranked.map(r => [r.arm, r]));
        const explore = Math.random() < 0.2;
        candidates.forEach(c => { c.rankScore = c.gain + 0.5 * (explore ? byArm[c.arm].sample : byArm[c.arm].expected); });
        candidates.sort((a, b) => b.rankScore - a.rankScore);
        const keep = candidates.slice(0, KEEP);

        const uploadedAt = new Date(asset.createdAt ?? asset.fileCreatedAt).getTime() || now();
        let i = 0;
        for (const c of keep) {
            const id = randomUUID();
            const why = explain(c, byArm[c.arm], tilt);
            const { embedding: _a, ...candidateScores } = c.scores;
            const { embedding, ...baseScores } = base;
            q.insert.run(id, userId, assetId, uploadedAt, now(), c.arm, c.name, JSON.stringify(c.recipe), why, c.gain, JSON.stringify(x), JSON.stringify({ candidate: candidateScores, base: baseScores }), i++);
            if (embedding) q.setEmbedding.run(JSON.stringify(embedding), id);
            const previewSize = Math.min(1, 1024 / Math.max(full.width, full.height));
            const before = resize(full, Math.round(full.width * previewSize), Math.round(full.height * previewSize));
            await writeJpeg(before, previewFile(id, 'before'));
            await writeJpeg(render(before, c.recipe), previewFile(id, 'after'));
        }
        log.info?.(`Suggestions for ${assetId}: ${keep.map(c => `${c.arm} (${c.gain.toFixed(2)})`).join(', ')}`);
        return skip(`suggested:${keep.length}`);
    }

    function explain(c, ranked, tilt) {
        const parts = [];
        if (c.arm.startsWith('straighten')) parts.push(`the horizon is ${Math.abs(tilt.angle)}° off`);
        if (c.verdict?.aesthetic > 0) parts.push('it scores better on aesthetics and photo quality');
        const preset = LEARNED_PRESETS.find(p => c.arm.endsWith(p.id));
        if (preset) parts.push(`you used "${preset.name}" on ${Math.round(preset.share * 35)} of your edited photos`);
        if (ranked?.observations) parts.push(`learned from ${ranked.observations} earlier reactions`);
        return parts.join('; ');
    }

    // ---- Greeting ----

    // One suggestion per subject: photos whose CLIP embeddings are very close (the same dish,
    // building, view…) form a group; only its best candidate is shown. "Best" weighs how much
    // the edit improves the photo and how interesting the photo is in the first place, so a
    // good edit of a mundane shot loses to a good edit of a striking one.
    const SAME_SUBJECT = 0.88;
    const similar = (a, b) => a && b && a.reduce((s, v, i) => s + v * b[i], 0) > SAME_SUBJECT;

    function bestPerSubject(rows) {
        const candidates = rows.map((row) => {
            const scores = JSON.parse(row.scores ?? '{}');
            const appeal = (scores.base?.aesthetic ?? 5) - 5;
            return { row, embedding: row.embedding ? JSON.parse(row.embedding) : null, value: row.gain + 0.35 * appeal };
        }).sort((a, b) => b.value - a.value);
        const kept = [];
        for (const c of candidates) {
            const sameSubject = kept.some(k => k.row.asset_id === c.row.asset_id
                || similar(k.embedding, c.embedding));
            if (!sameSubject) kept.push(c);
        }
        return new Map(kept.map(k => [k.row.asset_id, k.row]));
    }

    // The smallest window with at least 4 subjects to suggest for (else the widest that has any)
    function greeting(userId) {
        const t = now();
        const windows = WINDOWS.map(([ms, label]) => ({ perAsset: bestPerSubject(q.ready.all(userId, t - ms)), label }));
        const wanted = Math.min(4, windows.at(-1).perAsset.size);
        const chosen = wanted ? windows.find(w => w.perAsset.size >= wanted) : null;
        if (!chosen) return { window: null, text: null, suggestions: [] };
        const items = [...chosen.perAsset.values()].slice(0, 5);
        for (const row of items) q.shown.run(t, row.id);
        return {
            window: chosen.label,
            text: `Based on your uploads in the last ${chosen.label}, here are some edits`,
            suggestions: items.map(row => ({
                id: row.id, assetId: row.asset_id, name: row.name, why: row.why,
                summary: describeRecipe(JSON.parse(row.recipe)), recipe: JSON.parse(row.recipe),
            })),
        };
    }

    // The other photos the greeting folded into this suggestion's subject (asset ids, newest
    // uploads first); photos without an embedding never join a subject
    function subject(userId, id) {
        const row = q.get.get(id, userId);
        const embedding = row?.embedding ? JSON.parse(row.embedding) : null;
        if (!embedding) return [];
        const ids = new Set();
        for (const other of q.ready.all(userId, now() - WINDOWS.at(-1)[0])) {
            if (other.asset_id === row.asset_id || !other.embedding) continue;
            if (similar(embedding, JSON.parse(other.embedding))) ids.add(other.asset_id);
        }
        return [...ids];
    }

    // Photos that went to the trash: their suggestions are no longer offered
    function retire(userId, assetIds) {
        for (const assetId of assetIds) for (const row of q.forAsset.all(userId, assetId)) if (row.status === 'ready') q.setStatus.run('superseded', row.id);
    }

    function preview(userId, id, which) {
        if (!q.get.get(id, userId) || !['before', 'after'].includes(which)) return null;
        try {
            return readFileSync(previewFile(id, which));
        } catch {
            return null;
        }
    }

    function get(userId, id) {
        const row = q.get.get(id, userId);
        return row ? { ...row, recipe: JSON.parse(row.recipe), features: JSON.parse(row.features), scores: JSON.parse(row.scores) } : null;
    }

    // ---- Feedback ----

    function dismiss(userId, id) {
        const row = get(userId, id);
        if (!row || row.status !== 'ready') return false;
        q.setStatus.run('dismissed', id);
        learner.record(userId, { action: 'dismissed', arm: row.arm, assetId: row.asset_id, x: row.features, detail: { pair: { winner: row.scores.base, loser: row.scores.candidate } } });
        return true;
    }

    // Called when a save from a suggestion finished; `finalRecipe` may differ (tweaked)
    function accepted(userId, id, finalRecipe) {
        const row = get(userId, id);
        if (!row) return;
        q.setStatus.run('applied', id);
        q.siblings.run(userId, row.asset_id, id);
        const suggested = normalizeRecipe(row.recipe);
        const final = normalizeRecipe(finalRecipe);
        const delta = Object.fromEntries(ADJUST_KEYS.map(k => [k, final.adjust[k] - suggested.adjust[k]]).filter(([, v]) => Math.abs(v) >= 0.02));
        const tweaked = Object.keys(delta).length > 0 || JSON.stringify(final.geometry) !== JSON.stringify(suggested.geometry) || final.filter.id !== suggested.filter.id;
        learner.record(userId, { action: tweaked ? 'tweaked' : 'applied', arm: row.arm, assetId: row.asset_id, x: row.features, detail: { delta: tweaked ? delta : null, pair: { winner: row.scores.candidate, loser: row.scores.base } } });
    }

    // Your own edit of a photo we had suggestions for (or not): which arms were close?
    function manualEdit(userId, assetId, recipe) {
        const rows = q.forAsset.all(userId, assetId);
        const final = normalizeRecipe(recipe);
        for (const row of rows) {
            const s = normalizeRecipe(JSON.parse(row.recipe));
            const distance = ADJUST_KEYS.reduce((sum, k) => sum + Math.abs(final.adjust[k] - s.adjust[k]), 0) + (final.filter.id === s.filter.id ? 0 : 0.5) + Math.abs(final.geometry.angle - s.geometry.angle) / 4;
            const similar = distance < 0.8;
            q.setStatus.run(similar ? 'applied' : 'superseded', row.id);
            learner.record(userId, { action: similar ? 'similarManual' : 'unrelatedManual', arm: row.arm, assetId, x: JSON.parse(row.features), reward: similar ? REWARDS.similarManual : REWARDS.unrelatedManual });
        }
    }

    function discardedVersion(userId, assetId, edit) {
        if (edit?.source !== 'suggestion') return;
        learner.record(userId, { action: 'discarded', assetId, arm: null, detail: { editId: edit.editId } });
    }

    // Seen in the greeting for 7 days without a reaction: a weak "no"
    function expire() {
        for (const row of q.stale.all(now() - 7 * 24 * 3600e3)) {
            q.setStatus.run('ignored', row.id);
            learner.record(row.user_id, { action: 'ignored', arm: row.arm, assetId: row.asset_id, x: JSON.parse(row.features) });
        }
    }

    function forget(userId, assetId) {
        for (const row of q.forAsset.all(userId, assetId)) {
            rmSync(previewFile(row.id, 'before'), { force: true });
            rmSync(previewFile(row.id, 'after'), { force: true });
        }
    }

    function forAsset(userId, assetId) {
        return q.forAsset.all(userId, assetId).filter(r => r.status === 'ready').sort((a, b) => a.rank - b.rank)
            .map(row => ({ id: row.id, assetId: row.asset_id, name: row.name, why: row.why, recipe: JSON.parse(row.recipe), summary: describeRecipe(JSON.parse(row.recipe)) }));
    }

    return { process, greeting, subject, retire, preview, get, forAsset, dismiss, accepted, manualEdit, discardedVersion, expire, forget, setStatus: (id, s) => q.setStatus.run(s, id) };
}
