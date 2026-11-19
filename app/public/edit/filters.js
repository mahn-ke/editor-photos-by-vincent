// Filter presets, expressed in the same slider units as the Adjust panel so a filter at
// strength s simply adds s × its values. `mono` desaturates, `split` tints shadows and
// highlights (RGB offsets). Learned presets from your own edits are appended by
// learned-presets.js.

export const FILTERS = {
    none: { name: 'None' },
    vivid: { name: 'Vivid', adjust: { saturation: 0.35, contrast: 0.15, pop: 0.1, blueTone: 0.15 } },
    warm: { name: 'Warm', adjust: { warmth: 0.3, saturation: 0.08, highlights: -0.1 } },
    cool: { name: 'Cool', adjust: { warmth: -0.3, tint: 0.05, contrast: 0.05 } },
    golden: { name: 'Golden', adjust: { warmth: 0.4, saturation: 0.12, shadows: 0.1, highlights: -0.15 }, split: { shadows: [0.01, 0, -0.02], highlights: [0.03, 0.015, -0.02], amount: 1 } },
    matte: { name: 'Matte', adjust: { blackPoint: -0.4, highlights: -0.2, saturation: -0.15, contrast: -0.1 } },
    faded: { name: 'Faded', adjust: { blackPoint: -0.55, contrast: -0.25, saturation: -0.3, warmth: 0.08 } },
    punch: { name: 'Punch', adjust: { contrast: 0.3, pop: 0.35, saturation: 0.15, blackPoint: 0.15 } },
    teal: { name: 'Teal & Orange', adjust: { contrast: 0.15, saturation: 0.1 }, split: { shadows: [-0.03, 0.01, 0.035], highlights: [0.04, 0.015, -0.03], amount: 1 } },
    dusk: { name: 'Dusk', adjust: { warmth: 0.15, tint: 0.2, shadows: -0.1, saturation: 0.1 }, split: { shadows: [0.01, -0.01, 0.04], highlights: [0.04, 0.01, 0], amount: 1 } },
    neon: { name: 'Neon night', adjust: { contrast: 0.35, saturation: 0.35, blueTone: 0.45, blackPoint: 0.15, warmth: -0.3, tint: 0.2, pop: 0.25, highlights: -0.15 }, split: { shadows: [-0.03, 0.02, 0.07], highlights: [0.08, -0.03, 0.07], amount: 1 } },
    mono: { name: 'Mono', mono: true, adjust: { contrast: 0.1 } },
    'mono-contrast': { name: 'Mono High Contrast', mono: true, adjust: { contrast: 0.45, blackPoint: 0.25, pop: 0.2 } },
    'mono-soft': { name: 'Mono Soft', mono: true, adjust: { contrast: -0.1, blackPoint: -0.25, highlights: -0.15 } },
    sepia: { name: 'Sepia', mono: true, adjust: { contrast: 0.1, blackPoint: -0.15 }, split: { shadows: [0.04, 0.015, -0.03], highlights: [0.06, 0.03, -0.04], amount: 1 } },
};

export function registerFilters(extra) {
    for (const [id, filter] of Object.entries(extra)) {
        if (!FILTERS[id]) FILTERS[id] = filter;
    }
}

export function filterNames() {
    return Object.fromEntries(Object.entries(FILTERS).map(([id, f]) => [id, f.name]));
}
