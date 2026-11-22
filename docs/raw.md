# RAW (Pixel DNG) as the edit source

With `RAW_EDITS=1`, edits render from the RAW twin of a Pixel JPEG whenever its camera look can be
matched, so they work on 16-bit sensor data instead of the 8-bit JPEG. The match ("baseline") is
fitted per photo. It is off by default: tone and colour match, detail does not yet (see the end).

Pipeline (`src/raw.js`, run in `src/raw-worker.js`):
1. LibRaw `dcraw_emu` → 16-bit linear raw camera RGB, unit white balance, unrotated (`-t 0`).
2. Noise reduction with the DNG's NoiseProfile (variance S·x + O per plane): generalised Anscombe
   transform (unit-variance noise), orthonormal luma/chroma split, à-trous B3 wavelet soft
   thresholding at 2.5 σ (luma) and 4 σ (chroma) per scale — the order of the published HDR+
   finishing pipeline (chroma denoised harder). `RAW_DENOISE="luma,chroma"` / `0` for experiments.
3. Lens shading: OpcodeList2 GainMaps per sensor plane, then white balance and colour from the
   DNG (AsShotWhiteXY → camera neutral via ColorMatrix, ForwardMatrix → XYZ D50 → sRGB, both
   interpolated by colour temperature).
4. Lens distortion: OpcodeList3 WarpRectilinear (strong on the ultra-wide; skipped below ½ px).
5. Local tone map: the DNG 1.6 ProfileGainTableMap (Google's HDR+ gains, 48×64×257),
   indexed by the pixel before BaselineExposure (measured lower error than after).
6. EXIF orientation.
7. Alignment to the JPEG: scale search 0.7–1.0 (the JPEG may show less of the scene) refined
   to 0.3 %, plus phase correlation on brightness-normalised gradients.
8. Fit on an area-averaged ~320 px image: per-channel monotone curves, a 3×3 colour matrix and a
   16×12×8 bilateral local gain grid.
9. Detail: luma sharpening at five à-trous scales (1–16 px), fitted per photo on the central
   1024² of the full-size camera JPEG — gains bring the most detailed blocks to the JPEG's detail
   energy, iterated three times; only detail above 3× the remaining noise of each scale
   (measured in the flattest blocks) is amplified (coring). Stored with the baseline.

Measured on eight real pairs (night, NIGHT mode, indoor, daylight, ultra-wide, zoom): colour error
(median, sRGB × 100; limit 6) 1.6–5.0. At full resolution, on the six pairs that use the RAW:
detail 0.94–1.10× the camera JPEG's at every scale, noise in flat areas 0.2–0.96× the JPEG's. `node scripts/raw-measure.js <dir>` reproduces
it on a folder of `PXL_….RAW-01.jpg` + `PXL_….RAW-02.ORIGINAL.dng` pairs (`DUMP=<dir>` writes
RAW | RAW + baseline | JPEG comparisons, `VERBOSE=1 RAW_DEBUG=1` the error breakdown, `FULL=1` detail and noise at full resolution).

Bugs fixed on the way, each worth more than any model change: the developed TIFF was read as
8 bits (sharp needs `toColourspace('rgb16')`), portrait DNGs were never rotated, and the crop
used 1/scale instead of scale.

When the RAW is used (`raw-service.sourceFor`): a match within the limit and a RAW crop of at
least 85 % of the JPEG's size (zoom shots store a small crop the camera upscales with
multi-frame detail; there the JPEG is better).

Applying a suggestion keeps the RAW as the original: it gets the edit history and its baseline
(`editor-photos-raw` metadata, so later edits work after the JPEG is gone), the edit is stacked
on it as the primary and the camera JPEG goes to the trash. The editor previews and masks such a
RAW through its baseline (`/api/edit/:id/look.jpg`).

Cost: a fit or a 12 MP render takes 3–5 s and about 1 GB; one runs at a time in a worker that
is ended after each job. Downloaded DNGs are cached for a week.

Open — why it is still off by default: detail *energy* matches, but at 100 % night and indoor
shots still resolve less fine structure than the camera JPEG (small text, thin branches): the
camera's burst processing puts detail into the JPEG that the DNG does not contain, and no
sharpening can recreate it (AHD, DHT and AAHD demosaicing measure the same). Daylight shots match.
Applying a suggestion with RAW_EDITS=1 trashes the camera JPEG, so that detail is lost for good.
Saturated reds also come out slightly less saturated and paper white slightly pink (the profile
look table is not applied).

Also not done: WarpRectilinear2 (the newer high-order distortion model; WarpRectilinear approximates
it), the ProfileLookTable / ProfileToneCurve (the fitted curves and matrix stand in for them),
and noise reduction — a single RAW frame is noisier in deep shadows than the merged JPEG.
