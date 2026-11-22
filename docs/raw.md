# RAW (Pixel DNG) as the edit source

With `RAW_EDITS=1`, edits render from the RAW twin of a Pixel JPEG whenever its camera look can be
matched, so they work on 16-bit sensor data instead of the 8-bit JPEG. The match ("baseline") is
fitted per photo. It is off by default: tone and colour match, detail does not yet (see the end).

Pipeline (`src/raw.js`, run in `src/raw-worker.js`):
1. LibRaw `dcraw_emu` → 16-bit linear sRGB, camera white balance, unrotated (`-t 0`).
2. Lens shading: OpcodeList2 GainMaps (sensor coordinates).
3. Lens distortion: OpcodeList3 WarpRectilinear (strong on the ultra-wide).
4. Local tone map: the DNG 1.6 ProfileGainTableMap (Google's HDR+ gains, 48×64×257),
   indexed by the pixel before BaselineExposure (measured lower error than after).
5. EXIF orientation.
6. Alignment to the JPEG: scale search 0.7–1.0 (the JPEG may show less of the scene) refined
   to 0.3 %, plus phase correlation on brightness-normalised gradients.
7. Fit on an area-averaged ~320 px image: per-channel monotone curves, a 3×3 colour matrix and a
   16×12×8 bilateral local gain grid.

Measured on eight real pairs (night, NIGHT mode, indoor, daylight, ultra-wide, zoom; median colour
error, sRGB × 100; limit 6): 2.3–4.4, median 3.1. `node scripts/raw-measure.js <dir>` reproduces
it on a folder of `PXL_….RAW-01.jpg` + `PXL_….RAW-02.ORIGINAL.dng` pairs (`DUMP=<dir>` writes
RAW | RAW + baseline | JPEG comparisons, `VERBOSE=1 RAW_DEBUG=1` the error breakdown).

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

Open — why it is off by default: at 100 % the RAW render is clearly softer than the camera JPEG
in daylight (high-frequency energy 0.15–0.17× the JPEG's) and noisier at night. The camera merges
frames, denoises and sharpens; none of that is reproduced, and interpolation is not the cause
(skipping sub-pixel warps and resizes changed nothing). Since applying a suggestion trashes the
camera JPEG, turning this on trades detail for colour depth for good. Next: luminance denoising
scaled by the DNG's NoiseProfile, then sharpening fitted to the JPEG's detail energy.

Also not done: WarpRectilinear2 (the newer high-order distortion model; WarpRectilinear approximates
it), the ProfileLookTable / ProfileToneCurve (the fitted curves and matrix stand in for them),
and noise reduction — a single RAW frame is noisier in deep shadows than the merged JPEG.
