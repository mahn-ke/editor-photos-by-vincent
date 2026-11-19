// One-off: computes CLIP ViT-B/32 text embeddings for the quality prompts the grader uses
// and writes src/ml/clip-prompts.json, so the server never needs the text model.
// Usage: node scripts/clip-prompts.js <scratch-dir>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ort from 'onnxruntime-node';

const REV = '6b7c523703ae26e39be4b03774966f8571c7f523';
const BASE = `https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/${REV}`;

export const PROMPT_PAIRS = {
    quality: ['Good photo.', 'Bad photo.'],
    beauty: ['A beautiful photo.', 'An ugly photo.'],
    natural: ['A photo with natural colors.', 'A photo with oversaturated, unnatural colors.'],
    exposure: ['A well exposed photo.', 'An overexposed or underexposed photo.'],
    level: ['A photo with a perfectly level horizon.', 'A crooked, tilted photo.'],
    screen: ['A photo of a computer screen, monitor, TV or phone display.', 'A photo of a real-world scene.'],
    night: ['A photo of a city at night with neon lights.', 'A photo taken in daylight.'],
};

async function download(name, dir) {
    const file = path.join(dir, name.replace(/\//g, '_'));
    try {
        readFileSync(file);
        return file;
    } catch {}
    const response = await fetch(`${BASE}/${name}`);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    return file;
}

// GPT-2 style byte-to-unicode table used by CLIP's BPE
function bytesToUnicode() {
    const bs = [];
    for (let i = 33; i <= 126; i++) bs.push(i);
    for (let i = 161; i <= 172; i++) bs.push(i);
    for (let i = 174; i <= 255; i++) bs.push(i);
    const cs = [...bs];
    let n = 0;
    for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n++); }
    return Object.fromEntries(bs.map((b, i) => [b, String.fromCodePoint(cs[i])]));
}

function makeTokenizer(vocab, merges) {
    const ranks = new Map(merges.map((m, i) => [m, i]));
    const byteMap = bytesToUnicode();
    const bpe = (token) => {
        let word = [...token.slice(0, -1)].concat(token.slice(-1) + '</w>');
        for (;;) {
            let best = null;
            for (let i = 0; i < word.length - 1; i++) {
                const rank = ranks.get(`${word[i]} ${word[i + 1]}`);
                if (rank !== undefined && (best === null || rank < best.rank)) best = { rank, i };
            }
            if (!best) break;
            const merged = [];
            for (let i = 0; i < word.length; i++) {
                if (i < word.length - 1 && `${word[i]} ${word[i + 1]}` === `${word[best.i]} ${word[best.i + 1]}`) {
                    merged.push(word[i] + word[i + 1]);
                    i++;
                } else merged.push(word[i]);
            }
            word = merged;
        }
        return word;
    };
    return (text) => {
        const ids = [49406];
        const pattern = /'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;
        for (const piece of text.toLowerCase().trim().match(pattern) ?? []) {
            const encoded = [...new TextEncoder().encode(piece)].map(b => byteMap[b]).join('');
            for (const t of bpe(encoded)) ids.push(vocab[t]);
        }
        ids.push(49407);
        return ids;
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const dir = process.argv[2];
    const vocab = JSON.parse(readFileSync(await download('vocab.json', dir), 'utf8'));
    const merges = readFileSync(await download('merges.txt', dir), 'utf8').split('\n').slice(1).filter(Boolean);
    const tokenize = makeTokenizer(vocab, merges);
    const session = await ort.InferenceSession.create(await download('onnx/text_model_quantized.onnx', dir));
    console.log('inputs', session.inputNames, 'outputs', session.outputNames);
    const embed = async (text) => {
        const ids = tokenize(text);
        const len = 77;
        const input = new BigInt64Array(len);
        const mask = new BigInt64Array(len);
        ids.slice(0, len).forEach((id, i) => { input[i] = BigInt(id); mask[i] = 1n; });
        const feeds = { input_ids: new ort.Tensor('int64', input, [1, len]) };
        if (session.inputNames.includes('attention_mask')) feeds.attention_mask = new ort.Tensor('int64', mask, [1, len]);
        const out = await session.run(feeds);
        const vec = Array.from((out.text_embeds ?? out[session.outputNames[0]]).data).slice(0, 512);
        const norm = Math.hypot(...vec);
        return vec.map(v => Math.round((v / norm) * 1e6) / 1e6);
    };
    const pairs = {};
    for (const [key, [pos, neg]] of Object.entries(PROMPT_PAIRS)) {
        pairs[key] = { positive: pos, negative: neg, embeddings: [await embed(pos), await embed(neg)] };
        console.log(key, tokenize(pos).length, 'tokens');
    }
    writeFileSync(new URL('../src/ml/clip-prompts.json', import.meta.url), JSON.stringify({ model: `Xenova/clip-vit-base-patch32@${REV} text_model_quantized`, pairs }));
    console.log('wrote src/ml/clip-prompts.json');
}
