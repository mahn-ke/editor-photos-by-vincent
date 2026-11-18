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
    depth: {
        url: `${HF}/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_int8.onnx`,
        sha256: '01aa7a23de3f4a0ee1a2bb9997e6918104c85a9f95dea46d27b9b3fb0c6b9001',
        size: 27258801,
        licence: 'Apache-2.0 (Depth Anything V2 Small)',
    },
    matte: {
        url: `${HF}/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model_quantized.onnx`,
        sha256: '92e49898c3e05a6d7a944fc67a8cb87c4aad754ffb6ebd949528c7d1105fee3a',
        size: 6632188,
        licence: 'Apache-2.0 (MODNet)',
    },
    sky: {
        url: `${HF}/JianyuanWang/skyseg/resolve/3ba8c6df1d9ba9ff26f637c7ba9568ac11a9aa7f/skyseg.onnx`,
        sha256: 'ab9c34c64c3d821220a2886a4a06da4642ffa14d5b30e8d5339056a089aa1d39',
        size: 175997079,
        licence: 'MIT (U²-Net sky segmentation)',
    },
    face: {
        url: 'https://github.com/opencv/opencv_zoo/raw/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
        sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
        size: 232589,
        licence: 'MIT (YuNet, OpenCV Zoo); used only to locate faces for Portrait light',
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
