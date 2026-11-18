// Pixel RAW+JPEG pairs: PXL_<date>_<time>[.NIGHT|.PORTRAIT|…].RAW-01[.MP.COVER].jpg (JPEG)
// and PXL_<date>_<time>[…].RAW-02.ORIGINAL.dng (DNG), same capture time.

const PAIR = /^(PXL_\d{8}_\d{6,9})((?:\.[A-Z]+)*)\.RAW-0([12])\b/i;
const MAX_SKEW_MS = 2000;

export function pairKey(fileName) {
    const m = PAIR.exec(String(fileName || ''));
    if (!m) return null;
    return { base: m[1], variant: m[2].toUpperCase(), part: m[3] === '1' ? 'jpeg' : 'raw' };
}

const isDng = asset => /\.dng$/i.test(asset.originalFileName || '') || /dng/i.test(asset.originalMimeType || '');
const isJpeg = asset => /\.jpe?g$/i.test(asset.originalFileName || '') || asset.originalMimeType === 'image/jpeg';

// Picks the JPEG and DNG of the same shot from a list of candidate assets
export function matchPair(assets, key) {
    const same = assets.filter(a => !a.isTrashed && pairKey(a.originalFileName)?.base === key.base);
    const jpeg = same.find(a => pairKey(a.originalFileName).part === 'jpeg' && isJpeg(a));
    const raw = same.find(a => pairKey(a.originalFileName).part === 'raw' && isDng(a));
    if (!jpeg || !raw) return null;
    const skew = Math.abs(new Date(jpeg.fileCreatedAt) - new Date(raw.fileCreatedAt));
    if (!(skew <= MAX_SKEW_MS)) return null;
    const modelA = jpeg.exifInfo?.model;
    const modelB = raw.exifInfo?.model;
    if (modelA && modelB && modelA !== modelB) return null;
    return { jpeg, raw };
}

// Stacks the pair with the JPEG side shown. Returns what happened (for logs and undo).
export async function stackPair(immich, auth, { jpeg, raw }) {
    if (jpeg.stack?.id && raw.stack?.id === jpeg.stack.id) return { status: 'already' };
    if (raw.stack?.id && raw.stack.id !== jpeg.stack?.id) return { status: 'skipped', reason: 'raw-in-other-stack' };
    // If the JPEG already heads a stack (e.g. edited versions), merge keeping its primary
    const head = jpeg.stack?.primaryAssetId ?? jpeg.id;
    const created = await immich.createStack(auth, [head, raw.id]);
    return { status: 'stacked', stackId: created.id, jpegId: jpeg.id, rawId: raw.id };
}
