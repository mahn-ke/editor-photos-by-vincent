# Edits learned from Google Photos

Source: the Google Photos album "TV", read from Google's editor without saving anything.
211 photos were read (some retried after timeouts); 35 had edits. Only slider values,
filters and rotation were recorded; no images or photo IDs are stored here.

| Pattern | Photos | Typical settings (Google slider units) |
|---|---|---|
| Vivid look | 10 | Vivid filter, saturation +0.41, blue tone +0.14, skin tone −0.24, pop +0.12, white point +0.11, shadows +0.10 |
| Gentle enhance | 10 | pop +0.12, saturation +0.12, shadows +0.07, contrast +0.08, highlights −0.04 |
| Deep blue sky | 8 | saturation +0.74, blue tone +0.34, highlights −0.28, contrast +0.12 |
| Warm lift | 4 | Bazaar filter, shadows +0.26, pop +0.15, white point +0.13, saturation +0.12 |
| B&W contrast | 2 | saturation −1, contrast +0.48, highlights +0.92, black point +0.17 |
| Sepia contrast | 1 | saturation −1, contrast +0.73, warmth +1, tint +1 |
| Straighten | 4 | rotation of 1–2° |

Slider usage across all 35 edits: saturation 26, highlights 23, shadows 23, pop 21,
blue tone 19, white point 17, warmth 16, skin tone 15, tint 15, contrast 13,
brightness 11, black point 10, vignette 5. Crops kept "Free" aspect.

These become `app/public/edit/learned-presets.js`: suggestion candidates, entries in the
Filters tab, and the learner's starting values.
