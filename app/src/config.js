import path from 'node:path';

export function loadConfig(env = process.env) {
    const baseUrl = new URL(env.APP_BASE_URL || 'https://editor.photos.by.vincent.mahn.ke');
    const immichUrl = new URL(env.IMMICH_BASE_URL || 'https://photos.by.vincent.mahn.ke');
    return {
        port: Number(env.PORT || 3000),
        baseUrl: baseUrl.origin,
        immichUrl: immichUrl.href.replace(/\/+$/, ''),
        dataDir: env.DATA_DIR || path.join(process.cwd(), 'data'),
    };
}
