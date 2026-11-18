# RAW (Pixel DNG) as the edit source — status

What works:
- Pairing and stacking: every `PXL_….RAW-01….jpg` + `PXL_….RAW-02.ORIGINAL.dng` pair is stacked
  (JPEG shown), for the backfill and for new uploads, by the background job.
- Development: LibRaw `dcraw_emu` (16-bit linear sRGB, camera WB) plus the DNG's OpcodeList2
  lens-shading GainMaps, applied per channel.
- Alignment to the JPEG: size-based scale (zoom shots store a crop) plus phase correlation on
  gradient images. Good on most full-frame shots (confidence ≈ 5), weak on some (≈ 0.3).
- Baseline fit: per-channel monotone tone curves (extrapolated above the JPEG's clip point,
  so highlights keep RAW headroom) and a ridge-regularised 3×3 colour matrix.

Measured on four real pairs (median colour error, sRGB × 100; the editor needs ≤ 6):
global fit 8.5–10.4, so the editor currently falls back to editing the JPEG for every photo.
Errors are largest in the shadows, which the Pixel's HDR+ local tone mapping lifts.

Next steps:
1. Apply the DNG 1.6 ProfileGainTableMap (Google's own local tone map, 64×48×257 gains in the
   DNG) and the profile tone curve / look table before fitting: the remaining error is mostly
   that local tone mapping.
2. Fix the bilateral local-gain grid (currently makes the match worse; `RAW_LOCAL_GRID=1`).
3. Apply WarpRectilinear and refine alignment with ECC for the low-confidence shots.
4. Then: send the aligned linear preview to the editor (endpoint exists:
   `/api/edit/:id/raw/preview`) and apply the baseline in the worker, with Brightness, White
   Point, Highlights and Warmth/Tint acting on the linear RAW before the baseline.

`RAW_DEBUG=1` logs per-channel bias, error by brightness, error by region and alignment for
each fit.
