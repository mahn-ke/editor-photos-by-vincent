// Grades whether an edit improves a photo.
//
// General aesthetic models are weak at ranking near-identical variants of one photo, so
// no single score decides: a candidate must (1) pass cheap guards (no extra clipping,
// colours not pushed into oversaturation), (2) improve both the LAION aesthetic score and
// CLIP-IQA-style "good vs bad photo" prompts, averaged over crops and a mirror image,
// and (3) clear a minimum gain. Personal preference is added later by the learner.

import { readFileSync } from 'node:fs';
import ort from 'onnxruntime-node';
import { luminance, resize } from '../../public/edit/pipeline.js';
import { ensureModel } from './models.js';

const HEAD = JSON.parse(readFileSync(new URL('./laion-aesthetic-vit-b-32.json', import.meta.url), 'utf8'));
const PROMPTS = JSON.parse(readFileSync(new URL('./clip-prompts.json', import.meta.url), 'utf8')).pairs;
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const SIZE = 224;

function cropSquare(img, cx, cy, side) {
    const out = { width: side, height: side, data: new Float32Array(side * side * 3) };
    const x0 = Math.round(cx - side / 2);
    const y0 = Math.round(cy - side / 2);
    for (let y = 0; y < side; y++) {
        const src = ((y0 + y) * img.width + x0) * 3;
        out.data.set(img.data.subarray(src, src + side * 3), y * side * 3);
    }
    return out;
}

// CLIP-style views: centre crop plus the two ends along the long side, each also mirrored
export function views(img) {
    const side = Math.min(img.width, img.height);
    const scale = SIZE / side;
    const small = resize(img, Math.max(SIZE, Math.round(img.width * scale)), Math.max(SIZE, Math.round(img.height * scale)));
    const s = SIZE;
    const centres = small.width > small.height
        ? [[small.width / 2, s / 2], [s / 2, s / 2], [small.width - s / 2, s / 2]]
        : [[s / 2, small.height / 2], [s / 2, s / 2], [s / 2, small.height - s / 2]];
    return centres.map(([cx, cy]) => cropSquare(small, cx, cy, s));
}

function toTensor(batch) {
    const data = new Float32Array(batch.length * 3 * SIZE * SIZE);
    batch.forEach(({ img, mirror }, b) => {
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const sx = mirror ? SIZE - 1 - x : x;
                const j = (y * SIZE + sx) * 3;
                for (let c = 0; c < 3; c++) data[((b * 3 + c) * SIZE + y) * SIZE + x] = (img.data[j + c] - MEAN[c]) / STD[c];
            }
        }
    });
    return new ort.Tensor('float32', data, [batch.length, 3, SIZE, SIZE]);
}

const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const normalise = v => {
    const n = Math.hypot(...v) || 1;
    return v.map(x => x / n);
};

export function createGrader({ modelDir, log = console }) {
    let session = null;

    async function load() {
        if (session) return session;
        const file = await ensureModel('clip-vision', modelDir, { log });
        session = await ort.InferenceSession.create(file, { intraOpNumThreads: 2, graphOptimizationLevel: 'all' });
        return session;
    }

    // Mean normalised CLIP embedding over 3 crops × 2 mirrors
    async function embed(img) {
        const s = await load();
        const batch = views(img).flatMap(v => [{ img: v, mirror: false }, { img: v, mirror: true }]);
        const out = await s.run({ [s.inputNames[0]]: toTensor(batch) });
        const tensor = out.image_embeds ?? out[s.outputNames[0]];
        const dim = tensor.dims.at(-1);
        const embeddings = [];
        for (let b = 0; b < batch.length; b++) embeddings.push(normalise(Array.from(tensor.data.subarray(b * dim, (b + 1) * dim))));
        return embeddings;
    }

    function scoreEmbeddings(embeddings) {
        const mean = (f) => embeddings.reduce((sum, e) => sum + f(e), 0) / embeddings.length;
        const prompt = key => mean((e) => {
            const [pos, neg] = PROMPTS[key].embeddings;
            const a = 100 * dot(e, pos);
            const b = 100 * dot(e, neg);
            return 1 / (1 + Math.exp(b - a));
        });
        return {
            aesthetic: mean(e => dot(e, HEAD.weight) + HEAD.bias),
            quality: prompt('quality'),
            beauty: prompt('beauty'),
            natural: prompt('natural'),
            exposure: prompt('exposure'),
            level: prompt('level'),
            screen: PROMPTS.screen ? prompt('screen') : 0,
            night: PROMPTS.night ? prompt('night') : 0,
        };
    }

    async function score(img) {
        const embeddings = await embed(img);
        return { ...scoreEmbeddings(embeddings), ...pixelStats(img) };
    }

    // Decides whether `candidate` (a score) improves on `original`
    function judge(original, candidate, { mono = false, straighten = false } = {}) {
        const d = key => candidate[key] - original[key];
        const reasons = [];
        if (d('clipped') > 0.01) reasons.push('clips highlights or shadows');
        if (!mono && d('natural') < -0.15) reasons.push('colours look unnatural');
        if (!mono && candidate.colourfulness > Math.max(original.colourfulness * 1.6, original.colourfulness + 0.12)) reasons.push('oversaturated');
        const aesthetic = d('aesthetic');
        const prompts = (d('quality') + d('beauty') + d('exposure')) / 3;
        if (aesthetic <= 0) reasons.push('lower aesthetic score');
        if (prompts <= 0) reasons.push('CLIP prompts prefer the original');
        if (straighten && d('level') < 0) reasons.push('not more level');
        const gain = aesthetic + prompts * 4 + (straighten ? Math.max(0, d('level')) * 2 : 0);
        return { improved: reasons.length === 0 && gain >= 0.04, gain: Math.round(gain * 1000) / 1000, reasons, aesthetic: Math.round(aesthetic * 1000) / 1000, prompts: Math.round(prompts * 1000) / 1000 };
    }

    return { score, judge, embed, load };
}

// Cheap, deterministic guard statistics
export function pixelStats(img) {
    const L = luminance(img);
    let clipped = 0;
    let rg2 = 0, yb2 = 0, rgm = 0, ybm = 0;
    const d = img.data;
    const n = L.length;
    for (let p = 0, j = 0; p < n; p++, j += 3) {
        if (L[p] > 0.985 || L[p] < 0.01) clipped++;
        const rg = d[j] - d[j + 1];
        const yb = 0.5 * (d[j] + d[j + 1]) - d[j + 2];
        rgm += rg; ybm += yb; rg2 += rg * rg; yb2 += yb * yb;
    }
    rgm /= n; ybm /= n;
    const srg = Math.sqrt(Math.max(0, rg2 / n - rgm * rgm));
    const syb = Math.sqrt(Math.max(0, yb2 / n - ybm * ybm));
    return {
        clipped: clipped / n,
        // Hasler–Süsstrunk colourfulness, on 0..1 values
        colourfulness: Math.hypot(srg, syb) + 0.3 * Math.hypot(rgm, ybm),
    };
}
