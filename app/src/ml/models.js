// Model files are downloaded on first use into MODEL_DIR (the data volume), pinned to a
// repository revision and verified by sha256, so a changed upstream file is never used.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HF = 'https://huggingface.co';

export const MODELS = {
    'clip-vision': {
        url: `${HF}/Xenova/clip-vit-base-patch32/resolve/6b7c523703ae26e39be4b03774966f8571c7f523/onnx/vision_model_quantized.onnx`,
        sha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299',
        size: 89117001,
        licence: 'MIT (OpenAI CLIP, Xenova ONNX export)',
    },
};

async function sha256(file) {
    const hash = createHash('sha256');
    const handle = await open(file);
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return hash.digest('hex');
}

const inflight = new Map();

export function modelPath(name, modelDir) {
    if (!MODELS[name]) throw new Error(`Unknown model ${name}`);
    return path.join(modelDir, `${name}.onnx`);
}

export async function ensureModel(name, modelDir, { fetchImpl = fetch, log = console } = {}) {
    const spec = MODELS[name];
    const file = modelPath(name, modelDir);
    if (existsSync(file) && statSync(file).size === spec.size) return file;
    if (inflight.has(file)) return inflight.get(file);
    const job = (async () => {
        mkdirSync(modelDir, { recursive: true });
        const tmp = `${file}.download`;
        log.info?.(`Downloading model ${name} (${Math.round(spec.size / 1e6)} MB)`);
        const response = await fetchImpl(spec.url, { redirect: 'follow' });
        if (!response.ok || !response.body) throw new Error(`Model download ${name} failed: HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
        const digest = await sha256(tmp);
        if (digest !== spec.sha256) {
            rmSync(tmp, { force: true });
            throw new Error(`Model ${name} failed its checksum`);
        }
        renameSync(tmp, file);
        return file;
    })();
    inflight.set(file, job);
    try {
        return await job;
    } finally {
        inflight.delete(file);
    }
}
