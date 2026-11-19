// The edit recipe: one JSON shape shared by the browser editor, the server renderer,
// the suggestion engine and the metadata stored on Immich assets.

export const RECIPE_VERSION = 1;

import { defaultAdvanced, isAdvancedIdentity, normalizeAdvanced } from './advanced.js';

// Same order and ranges as Google Photos' Adjust panel
export const ADJUST_KEYS = [
    'hdr', 'brightness', 'contrast', 'whitePoint', 'highlights', 'shadows', 'blackPoint',
    'saturation', 'warmth', 'tint', 'skinTone', 'blueTone', 'pop', 'vignette',
];
export const UNIPOLAR = new Set(['hdr', 'pop', 'vignette']);
export const ADJUST_LABELS = {
    hdr: 'HDR effect', brightness: 'Brightness', contrast: 'Contrast', whitePoint: 'White Point',
    highlights: 'Highlights', shadows: 'Shadow', blackPoint: 'Black Point', saturation: 'Saturation',
    warmth: 'Warmth', tint: 'Tint', skinTone: 'Skin Tone', blueTone: 'Blue Tone', pop: 'Pop', vignette: 'Vignette',
};

export const ASPECTS = [
    ['free', 'Free', null], ['original', 'Original', null],
    ['16:9', '16:9', 16 / 9], ['9:16', '9:16', 9 / 16],
    ['5:4', '5:4', 5 / 4], ['4:5', '4:5', 4 / 5],
    ['4:3', '4:3', 4 / 3], ['3:4', '3:4', 3 / 4],
    ['3:2', '3:2', 3 / 2], ['2:3', '2:3', 2 / 3],
    ['square', 'Square', 1],
];
export const SKY_PALETTES = ['vivid', 'luminous', 'radiant', 'ember', 'airy', 'afterglow', 'stormy'];
export const MAX_ANGLE = 45;

const round = (value, digits) => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

export function defaultRecipe() {
    return {
        v: RECIPE_VERSION,
        source: { kind: 'jpeg' },
        geometry: { rotate90: 0, angle: 0, aspect: 'free', crop: null },
        adjust: Object.fromEntries(ADJUST_KEYS.map(key => [key, 0])),
        filter: { id: 'none', strength: 1 },
        advanced: defaultAdvanced(),
        tools: {
            sky: { palette: 'vivid', strength: 0 },
            colorFocus: { strength: 0 },
            portraitLight: { x: 0.3, y: 0.25, strength: 0 },
            blur: { strength: 0, focus: { x: 0.5, y: 0.5 } },
        },
    };
}

function normalizeCrop(crop) {
    if (!crop || typeof crop !== 'object') return null;
    const w = clamp(num(crop.w, 1), 0.01, 1);
    const h = clamp(num(crop.h, 1), 0.01, 1);
    return {
        cx: round(clamp(num(crop.cx, 0.5), 0, 1), 5),
        cy: round(clamp(num(crop.cy, 0.5), 0, 1), 5),
        w: round(w, 5),
        h: round(h, 5),
    };
}

// Validates and clamps anything coming from a browser, metadata or suggestion
export function normalizeRecipe(input = {}) {
    const base = defaultRecipe();
    const r = input && typeof input === 'object' ? input : {};
    const g = r.geometry || {};
    const aspectIds = new Set(ASPECTS.map(([id]) => id));
    const out = {
        v: RECIPE_VERSION,
        source: r.source?.kind === 'raw' && typeof r.source.rawAssetId === 'string'
            ? { kind: 'raw', rawAssetId: r.source.rawAssetId, baselineId: typeof r.source.baselineId === 'string' ? r.source.baselineId : null }
            : { kind: 'jpeg' },
        geometry: {
            rotate90: ((Math.round(num(g.rotate90)) % 4) + 4) % 4,
            angle: round(clamp(num(g.angle), -MAX_ANGLE, MAX_ANGLE), 2),
            aspect: aspectIds.has(g.aspect) ? g.aspect : 'free',
            crop: normalizeCrop(g.crop),
        },
        adjust: {},
        filter: {
            id: typeof r.filter?.id === 'string' && r.filter.id.length <= 40 ? r.filter.id : 'none',
            strength: round(clamp(num(r.filter?.strength, 1), 0, 1), 2),
        },
        tools: structuredClone(base.tools),
        advanced: normalizeAdvanced(r.advanced),
    };
    for (const key of ADJUST_KEYS) {
        const min = UNIPOLAR.has(key) ? 0 : -1;
        out.adjust[key] = round(clamp(num(r.adjust?.[key]), min, 1), 2);
    }
    const t = r.tools || {};
    out.tools.sky = {
        palette: SKY_PALETTES.includes(t.sky?.palette) ? t.sky.palette : 'vivid',
        strength: round(clamp(num(t.sky?.strength), 0, 1), 2),
    };
    out.tools.colorFocus = { strength: round(clamp(num(t.colorFocus?.strength), 0, 1), 2) };
    out.tools.portraitLight = {
        x: round(clamp(num(t.portraitLight?.x, 0.3), 0, 1), 3),
        y: round(clamp(num(t.portraitLight?.y, 0.25), 0, 1), 3),
        strength: round(clamp(num(t.portraitLight?.strength), 0, 1), 2),
    };
    out.tools.blur = {
        strength: round(clamp(num(t.blur?.strength), 0, 1), 2),
        focus: {
            x: round(clamp(num(t.blur?.focus?.x, 0.5), 0, 1), 3),
            y: round(clamp(num(t.blur?.focus?.y, 0.5), 0, 1), 3),
        },
    };
    return out;
}

export function isIdentity(recipe) {
    const r = normalizeRecipe(recipe);
    const g = r.geometry;
    const fullCrop = !g.crop || (Math.abs(g.crop.w - 1) < 1e-4 && Math.abs(g.crop.h - 1) < 1e-4);
    return g.rotate90 === 0 && g.angle === 0 && fullCrop
        && ADJUST_KEYS.every(key => r.adjust[key] === 0)
        && (r.filter.id === 'none' || r.filter.strength === 0)
        && r.tools.sky.strength === 0 && r.tools.colorFocus.strength === 0
        && r.tools.portraitLight.strength === 0 && r.tools.blur.strength === 0
        && isAdvancedIdentity(r.advanced);
}

export function recipesEqual(a, b) {
    return JSON.stringify(normalizeRecipe(a)) === JSON.stringify(normalizeRecipe(b));
}

// Short human summary, e.g. "Straighten −4.7°, Pop +0.20, B&W"
export function describeRecipe(recipe, filterNames = {}) {
    const r = normalizeRecipe(recipe);
    const parts = [];
    if (r.geometry.angle) parts.push(`Straighten ${r.geometry.angle > 0 ? '+' : '−'}${Math.abs(r.geometry.angle)}°`);
    if (r.geometry.rotate90) parts.push(`Rotate ${r.geometry.rotate90 * 90}°`);
    if (r.geometry.crop && (r.geometry.crop.w < 0.999 || r.geometry.crop.h < 0.999)) parts.push('Crop');
    for (const key of ADJUST_KEYS) {
        const value = r.adjust[key];
        if (value) parts.push(`${ADJUST_LABELS[key]} ${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`);
    }
    if (r.filter.id !== 'none' && r.filter.strength > 0) parts.push(filterNames[r.filter.id] || r.filter.id);
    if (r.tools.sky.strength) parts.push(`Sky (${r.tools.sky.palette})`);
    if (r.tools.colorFocus.strength) parts.push('Color focus');
    if (r.tools.portraitLight.strength) parts.push('Portrait light');
    if (r.tools.blur.strength) parts.push('Blur');
    if (!isAdvancedIdentity(r.advanced)) parts.push('Advanced');
    return parts.join(', ') || 'No changes';
}
