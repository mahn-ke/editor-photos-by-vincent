import path from 'node:path';

export function loadConfig(env = process.env) {
    const baseUrl = new URL(env.APP_BASE_URL || 'https://editor.photos.by.vincent.mahn.ke');
    const immichUrl = new URL(env.IMMICH_BASE_URL || 'https://photos.by.vincent.mahn.ke');
    return {
        port: Number(env.PORT || 3000),
        baseUrl: baseUrl.origin,
        immichUrl: immichUrl.href.replace(/\/+$/, ''),
        dataDir: env.DATA_DIR || path.join(process.cwd(), 'data'),
        appSecret: env.APP_SECRET || '',
        // Re-creatable data (models, mask and RAW caches) lives apart from what must be backed up
        cacheDir: env.CACHE_DIR || env.DATA_DIR || path.join(process.cwd(), 'data'),
        // Render edits from a Pixel photo's RAW twin and keep the RAW (not the camera JPEG) when
        // applying a suggestion. Off until the RAW render matches the camera's detail (docs/raw.md)
        rawEdits: env.RAW_EDITS === '1',
        modelDir: env.MODEL_DIR || path.join(env.CACHE_DIR || env.DATA_DIR || path.join(process.cwd(), 'data'), 'models'),
    };
}
