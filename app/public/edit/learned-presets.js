// Edit patterns learned from your own Google Photos edits (album "TV", 35 edited photos;
// see docs/learned-edits.md). Each preset is a recipe fragment in our slider units.
// `share` is how often the pattern occurred: the starting value (prior) for the learner.
// `ranges` bounds how far the strength model may move each slider for this preset.

import { registerFilters } from './filters.js';

export const LEARNED_PRESETS = [
    {
        id: 'learned-vivid',
        name: 'Vivid look',
        share: 10 / 35,
        recipe: { filter: { id: 'vivid', strength: 1 }, adjust: { saturation: 0.41, blueTone: 0.14, skinTone: -0.24, pop: 0.12, whitePoint: 0.11, shadows: 0.1, highlights: -0.08, contrast: 0.08 } },
        ranges: { saturation: [0.2, 0.9], blueTone: [0, 0.5], pop: [0.05, 0.3] },
    },
    {
        id: 'learned-enhance',
        name: 'Gentle enhance',
        share: 10 / 35,
        recipe: { adjust: { pop: 0.12, saturation: 0.12, shadows: 0.07, contrast: 0.08, highlights: -0.04, skinTone: -0.07 } },
        ranges: { pop: [0.05, 0.25], shadows: [0, 0.3] },
    },
    {
        id: 'learned-blue-sky',
        name: 'Deep blue sky',
        share: 8 / 35,
        recipe: { adjust: { saturation: 0.74, blueTone: 0.34, highlights: -0.28, contrast: 0.12, whitePoint: 0.05 } },
        ranges: { saturation: [0.4, 1], blueTone: [0.1, 1], highlights: [-0.9, 0] },
    },
    {
        id: 'learned-warm-lift',
        name: 'Warm lift',
        share: 4 / 35,
        recipe: { filter: { id: 'golden', strength: 0.5 }, adjust: { shadows: 0.26, pop: 0.15, whitePoint: 0.13, saturation: 0.12 } },
        ranges: { shadows: [0.1, 0.5] },
    },
    {
        id: 'learned-mono-contrast',
        name: 'B&W contrast',
        share: 2 / 35,
        recipe: { adjust: { saturation: -1, contrast: 0.48, highlights: 0.6, blackPoint: 0.17, shadows: 0.13, whitePoint: -0.23, vignette: 0.08 } },
        ranges: { contrast: [0.3, 0.8] },
    },
    {
        id: 'learned-sepia',
        name: 'Sepia contrast',
        share: 1 / 35,
        recipe: { filter: { id: 'sepia', strength: 1 }, adjust: { contrast: 0.5, blackPoint: 0.25, highlights: 0.4 } },
        ranges: { contrast: [0.3, 0.8] },
    },
];

// Straightening is learned separately: 4 of 35 edits rotated by 1–2°, so it is offered
// whenever the horizon detector is confident, alone or combined with a look above.
export const STRAIGHTEN = { id: 'straighten', name: 'Straighten', share: 4 / 35, maxAngle: 8 };

// The learned looks also appear in the Filters tab
registerFilters(Object.fromEntries(LEARNED_PRESETS.map(p => [p.id, {
    name: p.name,
    learned: true,
    adjust: p.recipe.adjust,
    ...(p.recipe.filter?.id === 'sepia' ? { mono: true, split: { shadows: [0.04, 0.015, -0.03], highlights: [0.06, 0.03, -0.04], amount: 1 } } : {}),
    ...(p.recipe.adjust.saturation === -1 ? { mono: true } : {}),
}])));
