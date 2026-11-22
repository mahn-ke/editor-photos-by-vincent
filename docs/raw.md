# RAW (Pixel DNG) as the edit source

With `RAW_EDITS=1`, edits render from the RAW twin of a Pixel JPEG whenever its camera look can be
matched, so they work on 16-bit sensor data instead of the 8-bit JPEG. The match ("baseline") is
fitted per photo. It is off by default: tone and colour match, detail does not yet (see the end).

Pipeline (`src/raw.js`, run in `src/raw-worker.js`):
1. LibRaw `dcraw_emu` → 16-bit linear raw camera RGB, unit white balance, unrotated (`-t 0`).
2. Noise reduction as Google Camera finishes HDR+ (reverse-engineered from the shaders in the
   Camera app's `libgcastartup.so`: `gaussian_3x3_downsample`, `bilateral_filter_luma`,
   `bilateral_filter_chroma`, `reconstruct_level`): generalised Anscombe transform with the DNG's
   NoiseProfile (variance S·x + O per plane), orthonormal luma/chroma split, then a Gaussian
   pyramid ([1 2 1]²/16, 5 levels) where each level is cleaned with a noise-model *sigma filter*
   — the mean of only those neighbours within 3σ of the centre, falling back to the 6σ set when
   too few pass — two passes per level, and each finer level takes the coarser result as
   `level + up(denoised(down) − down)`. Luma: symmetric 3×3 pairs at full resolution, 5×5 below,
   15 % of the original blended back (keeps fine texture and grain, like the camera's revert
   factor). Chroma: filtered jointly with the denoised luma (no bleeding across edges), sampling
   every second pixel, threshold from the luma noise (as the camera does).
   The noise is measured per level and by brightness (flattest blocks), not taken from the
   NoiseProfile alone: Pixel DNGs are merged bursts and the profile overstates their noise by
   0.3–1.2× depending on the photo and the brightness — the camera knows this from its merge
   (its denoise strength map). `RAW_DENOISE="luma,chroma,revert,second"` / `0` for experiments.
3. Clipped highlights to white: every channel saturates at 1 before white balance, which would
   lift clipped red and blue above green (magenta windows and lamps); each channel is clipped
   where white saturates, as dcraw's default highlight mode does.
   Lens shading: OpcodeList2 GainMaps per sensor plane, then white balance and colour from the
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
9. Detail from the camera JPEG: the phone's sharpness comes from its burst merge and ML deblur
   (in the Camera app: `hawk`, `pecan`, a PWC-Net flow model for multi-frame deblur). They cannot
   be reproduced here — the burst frames are not saved (the DNG *is* the merge) and the models
   are compiled for the Tensor TPU only (`edgetpu-custom-op`). So each render takes the luma
   detail of à-trous scales 1–16 px from the full-size camera JPEG (same framing and size after
   the alignment); tone, colour and coarser structure stay the RAW's. Where the JPEG is clipped
   or crushed (its 4-px smoothed brightness) the RAW keeps its own detail: the highlight and
   shadow detail an edit brings back. Without the JPEG (deleted), a fitted luma sharpening
   stands in (five scales, capped at +1.5, with coring; fitted on the central 1024² of the
   camera JPEG at fit time and stored with the baseline).

Measured on eight real pairs (night, NIGHT mode, indoor, daylight, ultra-wide, zoom): colour error
(median, sRGB × 100; limit 6) 1.6–5.1. With the camera's detail, on the six pairs that use the
RAW, detail is 1.0× the camera JPEG's at 1–4 px and 0.86–0.98× at 8–16 px (the shaken frames:
blur wider than 16 px stays), and the mean difference of 100 % crops to the camera JPEG fell
from 3.5–10.4 to 1.7–6.0 (sRGB × 100). `node scripts/raw-measure.js <dir>` reproduces
it on a folder of `PXL_….RAW-01.jpg` + `PXL_….RAW-02.ORIGINAL.dng` pairs (`DUMP=<dir>` writes
RAW | RAW + baseline | JPEG comparisons, `VERBOSE=1 RAW_DEBUG=1` the error breakdown, `FULL=1` detail and noise at full resolution).

Bugs fixed on the way, each worth more than any model change: the developed TIFF was read as
8 bits (sharp needs `toColourspace('rgb16')`), portrait DNGs were never rotated, and the crop
used 1/scale instead of scale.

When the RAW is used (`raw-service.sourceFor`): a match within the limit, a RAW crop of at
least 85 % of the JPEG's size (zoom shots store a small crop the camera upscales with
multi-frame detail; there the JPEG is better).

Applying a suggestion keeps the RAW as the original: it gets the edit history and its baseline
(`editor-photos-raw` metadata, with the camera JPEG's id), the edit is stacked on it as the
primary, and the camera JPEG stays in the stack — later renders take their fine detail from it.
The editor previews and masks such a RAW through its baseline (`/api/edit/:id/look.jpg`).

Cost: a fit or a 12 MP render takes 3–5 s and about 1 GB; one runs at a time in a worker that
is ended after each job. Downloaded DNGs are cached for a week.

Open — why it is still off by default: with the camera JPEG's detail the renders match the camera
at 100 %, so the earlier blocker (RAW renders resolving less than the JPEG) is gone; it needs a
look in real use before turning on. Saturated reds still come out slightly less saturated (the
profile look table is not applied), and blur wider than 16 px in shaken frames stays.

Also not done: WarpRectilinear2 (the newer high-order distortion model; WarpRectilinear approximates
it), the ProfileLookTable / ProfileToneCurve (the fitted curves and matrix stand in for them),
and the camera's ML stages themselves (TPU-only; their result arrives through the JPEG's detail).
