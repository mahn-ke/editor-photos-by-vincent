import { ADJUST_KEYS, ADJUST_LABELS, ASPECTS, MAX_ANGLE, UNIPOLAR, defaultRecipe, normalizeRecipe, recipesEqual } from './recipe.js';
import { aspectValue, constrainRect, cropToPixels, defaultRect, fitsInside, maxRectAt, orientedSize, pixelsToCrop } from './geometry.js';
import { FILTERS } from './filters.js';
import { autoRecipes } from './auto.js';

const $ = id => document.getElementById(id);
const assetId = $('editor').dataset.asset;
const stage = $('ed-stage');
const canvas = $('ed-canvas');
const ctx2d = canvas.getContext('2d');
const statusEl = $('ed-status');
const DEG = Math.PI / 180;

const state = {
    context: null,
    initial: defaultRecipe(),
    recipe: defaultRecipe(),
    tab: 'adjust',
    proxy: null, // { width, height }
    stats: null,
    toneBitmap: null, // tone-only render for the crop tab
    resultBitmap: null, // full render for other tabs
    crop: null, // crop UI state
    saving: false,
};

// ---- Worker ---------------------------------------------------------------

const worker = new Worker('/static/edit/worker.js', { type: 'module' });
let nextId = 1;
const pending = new Map();
worker.onmessage = ({ data }) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data);
};
const call = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload });
});

async function toBitmap({ rgba, width, height }) {
    return createImageBitmap(new ImageData(new Uint8ClampedArray(rgba.buffer), width, height));
}

// Coalesces render requests: at most one in flight, the latest one wins
let rendering = false;
let renderAgain = false;
async function requestRender() {
    if (!state.proxy) return;
    if (rendering) {
        renderAgain = true;
        return;
    }
    rendering = true;
    try {
        do {
            renderAgain = false;
            const mode = state.tab === 'crop' ? 'tone' : 'full';
            const result = await call('render', { recipe: state.recipe, mode });
            const bitmap = await toBitmap(result);
            if (mode === 'tone') {
                state.toneBitmap?.close();
                state.toneBitmap = bitmap;
            } else {
                state.resultBitmap?.close();
                state.resultBitmap = bitmap;
            }
            draw();
        } while (renderAgain);
    } catch (error) {
        statusEl.textContent = `Preview failed: ${error.message}`;
        statusEl.hidden = false;
    } finally {
        rendering = false;
    }
    updateDirty();
}

// ---- Drawing --------------------------------------------------------------

function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (state.crop) fitFrame(false);
    draw();
}

function stageBox() {
    const rect = stage.getBoundingClientRect();
    const pad = window.innerWidth < 700 ? 20 : 48;
    return { x: pad, y: pad, w: Math.max(10, rect.width - 2 * pad), h: Math.max(10, rect.height - 2 * pad) };
}

function draw() {
    const rect = stage.getBoundingClientRect();
    ctx2d.clearRect(0, 0, rect.width, rect.height);
    if (state.tab === 'crop' && state.crop && state.toneBitmap) return drawCrop();
    const bmp = state.resultBitmap;
    if (!bmp) return;
    const box = stageBox();
    const s = Math.min(box.w / bmp.width, box.h / bmp.height);
    const w = bmp.width * s;
    const h = bmp.height * s;
    ctx2d.imageSmoothingQuality = 'high';
    ctx2d.drawImage(bmp, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
}

// ---- Crop & rotate ----------------------------------------------------------
//
// Like Google Photos: the frame is axis-aligned on screen, the image rotates and scales
// behind it. `anchor` ties an image point to a screen point at a given scale; while a
// corner is dragged the anchor stays put, ~0.8 s after release the frame re-fits.

function orientedDims() {
    return orientedSize(state.proxy.width, state.proxy.height, state.recipe.geometry.rotate90);
}

function currentAspect() {
    const { width, height } = orientedDims();
    return aspectValue(state.recipe.geometry.aspect, width, height, ASPECTS);
}

function initCrop() {
    const { width: W, height: H } = orientedDims();
    const g = state.recipe.geometry;
    const rect = g.crop ? constrainRect(cropToPixels(g.crop, W, H), W, H, g.angle) : defaultRect(W, H, g.angle, currentAspect());
    state.crop = { rect, base: null, frame: null, anchor: null, drag: null, refitTimer: null, grid: 'thirds' };
    fitFrame(false);
}

function fitFrame(animate) {
    const c = state.crop;
    const box = stageBox();
    const aspect = c.rect.w / c.rect.h;
    let w = box.w;
    let h = w / aspect;
    if (h > box.h) {
        h = box.h;
        w = h * aspect;
    }
    const frame = { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
    const target = { frame, anchor: { sx: frame.x + w / 2, sy: frame.y + h / 2, ix: c.rect.cx, iy: c.rect.cy, scale: w / c.rect.w } };
    if (!animate || !c.frame) {
        c.frame = target.frame;
        c.anchor = target.anchor;
        draw();
        return;
    }
    const from = { frame: { ...c.frame }, anchor: { ...c.anchor } };
    const start = performance.now();
    const lerp = (a, b, t) => a + (b - a) * t;
    const step = (now) => {
        const t = Math.min(1, (now - start) / 260);
        const e = 1 - Math.pow(1 - t, 3);
        c.frame = Object.fromEntries(Object.keys(frame).map(k => [k, lerp(from.frame[k], frame[k], e)]));
        c.anchor = Object.fromEntries(Object.keys(target.anchor).map(k => [k, lerp(from.anchor[k], target.anchor[k], e)]));
        draw();
        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// Screen ↔ oriented-image coordinates through the anchor
function toScreen(ix, iy) {
    const { anchor } = state.crop;
    const a = state.recipe.geometry.angle * DEG;
    const dx = (ix - anchor.ix) * anchor.scale;
    const dy = (iy - anchor.iy) * anchor.scale;
    return { x: anchor.sx + dx * Math.cos(a) - dy * Math.sin(a), y: anchor.sy + dx * Math.sin(a) + dy * Math.cos(a) };
}

function toImage(sx, sy) {
    const { anchor } = state.crop;
    const a = -state.recipe.geometry.angle * DEG;
    const dx = (sx - anchor.sx) / anchor.scale;
    const dy = (sy - anchor.sy) / anchor.scale;
    return { x: anchor.ix + dx * Math.cos(a) - dy * Math.sin(a), y: anchor.iy + dx * Math.sin(a) + dy * Math.cos(a) };
}

function drawOriented(bmp, rotate90) {
    const { width: pw, height: ph } = state.proxy;
    if (rotate90 === 1) { ctx2d.translate(ph, 0); ctx2d.rotate(Math.PI / 2); }
    else if (rotate90 === 2) { ctx2d.translate(pw, ph); ctx2d.rotate(Math.PI); }
    else if (rotate90 === 3) { ctx2d.translate(0, pw); ctx2d.rotate(-Math.PI / 2); }
    ctx2d.drawImage(bmp, 0, 0, pw, ph);
}

function drawCrop() {
    const c = state.crop;
    const g = state.recipe.geometry;
    const { anchor, frame } = c;
    const view = stage.getBoundingClientRect();
    ctx2d.save();
    ctx2d.translate(anchor.sx, anchor.sy);
    ctx2d.rotate(g.angle * DEG);
    ctx2d.scale(anchor.scale, anchor.scale);
    ctx2d.translate(-anchor.ix, -anchor.iy);
    ctx2d.imageSmoothingQuality = 'high';
    drawOriented(state.toneBitmap, g.rotate90);
    ctx2d.restore();
    // Dim everything outside the frame
    ctx2d.save();
    ctx2d.fillStyle = 'rgba(0,0,0,0.62)';
    ctx2d.beginPath();
    ctx2d.rect(0, 0, view.width, view.height);
    ctx2d.rect(frame.x, frame.y, frame.w, frame.h);
    ctx2d.fill('evenodd');
    // Grid: thirds normally, a fine grid while straightening
    ctx2d.strokeStyle = c.grid === 'fine' ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.35)';
    ctx2d.lineWidth = 1;
    const n = c.grid === 'fine' ? 9 : 3;
    ctx2d.beginPath();
    for (let i = 1; i < n; i++) {
        const x = Math.round(frame.x + (frame.w * i) / n) + 0.5;
        const y = Math.round(frame.y + (frame.h * i) / n) + 0.5;
        ctx2d.moveTo(x, frame.y); ctx2d.lineTo(x, frame.y + frame.h);
        ctx2d.moveTo(frame.x, y); ctx2d.lineTo(frame.x + frame.w, y);
    }
    ctx2d.stroke();
    ctx2d.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx2d.lineWidth = 1.5;
    ctx2d.strokeRect(frame.x, frame.y, frame.w, frame.h);
    // Corner handles
    ctx2d.fillStyle = '#fff';
    for (const [x, y] of corners(frame)) {
        ctx2d.beginPath();
        ctx2d.arc(x, y, 6, 0, Math.PI * 2);
        ctx2d.fill();
    }
    ctx2d.restore();
}

const corners = f => [[f.x, f.y], [f.x + f.w, f.y], [f.x, f.y + f.h], [f.x + f.w, f.y + f.h]];

function commitCrop() {
    const { width: W, height: H } = orientedDims();
    const rect = state.crop.rect;
    const full = Math.abs(rect.w - W) < 0.5 && Math.abs(rect.h - H) < 0.5 && state.recipe.geometry.angle === 0;
    state.recipe.geometry.crop = full ? null : pixelsToCrop(rect, W, H);
    updateDirty();
}

// Rect in image coordinates for a frame drawn on screen (anchor unchanged)
function frameToRect(frame) {
    const centre = toImage(frame.x + frame.w / 2, frame.y + frame.h / 2);
    return { cx: centre.x, cy: centre.y, w: frame.w / state.crop.anchor.scale, h: frame.h / state.crop.anchor.scale };
}

function hitHandle(x, y) {
    const f = state.crop.frame;
    const list = corners(f);
    for (let i = 0; i < 4; i++) if (Math.hypot(x - list[i][0], y - list[i][1]) < 22) return i;
    return x > f.x && x < f.x + f.w && y > f.y && y < f.y + f.h ? 'pan' : null;
}

function onCropPointerDown(event) {
    if (state.tab !== 'crop' || !state.crop) return;
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const hit = hitHandle(x, y);
    if (hit === null) return;
    clearTimeout(state.crop.refitTimer);
    canvas.setPointerCapture(event.pointerId);
    state.crop.drag = { hit, x0: x, y0: y, frame0: { ...state.crop.frame }, rect0: { ...state.crop.rect }, anchor0: { ...state.crop.anchor } };
    state.crop.grid = 'thirds';
}

function onCropPointerMove(event) {
    const c = state.crop;
    if (!c?.drag) return;
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const { width: W, height: H } = orientedDims();
    const angle = state.recipe.geometry.angle;
    const d = c.drag;
    if (d.hit === 'pan') {
        // Move the image under the frame
        const a = -angle * DEG;
        const dx = -(x - d.x0) / d.anchor0.scale;
        const dy = -(y - d.y0) / d.anchor0.scale;
        const moved = { ...d.rect0, cx: d.rect0.cx + dx * Math.cos(a) - dy * Math.sin(a), cy: d.rect0.cy + dx * Math.sin(a) + dy * Math.cos(a) };
        c.rect = constrainRect(moved, W, H, angle);
        c.anchor = { ...c.anchor, ix: c.rect.cx, iy: c.rect.cy };
        draw();
        return;
    }
    // Corner drag: the opposite corner stays fixed on screen
    const f0 = d.frame0;
    const fixed = corners(f0)[3 - d.hit];
    const aspect = currentAspect();
    let nx = x;
    let ny = y;
    const minSize = 48;
    let w = Math.max(minSize, Math.abs(nx - fixed[0]));
    let h = Math.max(minSize, Math.abs(ny - fixed[1]));
    if (aspect) {
        if (w / h > aspect) w = h * aspect;
        else h = w / aspect;
    }
    const left = d.hit === 0 || d.hit === 2;
    const top = d.hit === 0 || d.hit === 1;
    const candidate = (scale) => {
        const cw = Math.max(minSize, scale * w + (1 - scale) * f0.w);
        const ch = aspect ? cw / aspect : Math.max(minSize, scale * h + (1 - scale) * f0.h);
        return { x: left ? fixed[0] - cw : fixed[0], y: top ? fixed[1] - ch : fixed[1], w: cw, h: ch };
    };
    // Largest step towards the pointer that keeps the crop inside the rotated image
    let frame = candidate(1);
    if (!fitsInside(frameToRect(frame), W, H, angle)) {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 12; i++) {
            const mid = (lo + hi) / 2;
            if (fitsInside(frameToRect(candidate(mid)), W, H, angle)) lo = mid;
            else hi = mid;
        }
        frame = candidate(lo);
    }
    c.frame = frame;
    c.rect = frameToRect(frame);
    draw();
}

function onCropPointerUp() {
    const c = state.crop;
    if (!c?.drag) return;
    const wasCorner = c.drag.hit !== 'pan';
    c.drag = null;
    commitCrop();
    if (wasCorner) c.refitTimer = setTimeout(() => fitFrame(true), 800);
}

function setAngle(value, { fine = false } = {}) {
    const g = state.recipe.geometry;
    let angle = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, value));
    angle = fine ? Math.round(angle * 10) / 10 : Math.round(angle);
    if (!fine && Math.abs(angle) < 0.3) angle = 0;
    if (angle === g.angle) return;
    const c = state.crop;
    const { width: W, height: H } = orientedDims();
    if (!c.base) c.base = { ...c.rect };
    g.angle = angle;
    // Frame stays put on screen; the crop shrinks (image zooms) just enough to stay covered
    const max = maxRectAt(W, H, angle, c.base.w / c.base.h, c.base.cx, c.base.cy);
    const scale = Math.min(1, max.w / c.base.w);
    c.rect = constrainRect({ ...c.base, w: c.base.w * scale, h: c.base.h * scale }, W, H, angle);
    c.anchor = { ...c.anchor, ix: c.rect.cx, iy: c.rect.cy, scale: c.frame.w / c.rect.w };
    c.grid = 'fine';
    commitCrop();
    updateRuler();
    draw();
}

function endStraighten() {
    if (!state.crop) return;
    state.crop.base = null;
    state.crop.grid = 'thirds';
    draw();
}

// Ruler: drag the tape. Plain drag moves in whole degrees, Shift+drag in 0.1°
const ruler = $('ed-ruler');
const rulerCanvas = $('ed-ruler-canvas');
const PX_PER_DEG = 4;

function updateRuler() {
    const angle = state.recipe.geometry.angle;
    const text = `${Number.isInteger(angle) ? angle : angle.toFixed(1)}°`;
    $('ed-angle').textContent = text;
    ruler.setAttribute('aria-valuenow', String(angle));
    ruler.setAttribute('aria-valuetext', text);
    const box = ruler.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    rulerCanvas.width = Math.round(box.width * dpr);
    rulerCanvas.height = Math.round(box.height * dpr);
    const c = rulerCanvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, box.width, box.height);
    const mid = box.width / 2;
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.font = '11px system-ui, sans-serif';
    c.textAlign = 'center';
    for (let deg = -90; deg <= 90; deg++) {
        const x = mid + (deg - angle) * PX_PER_DEG;
        if (x < -20 || x > box.width + 20) continue;
        const major = deg % 15 === 0;
        c.globalAlpha = Math.abs(deg) > MAX_ANGLE ? 0.3 : 1;
        c.fillRect(x - 0.5, major ? box.height - 16 : box.height - 9, 1, major ? 10 : 4);
        if (major && Math.abs(x - mid) > 18) c.fillText(`${deg}°`, x, box.height - 22);
    }
    c.globalAlpha = 1;
    c.fillStyle = '#adcbfa';
    c.beginPath();
    c.moveTo(mid - 5, box.height - 1);
    c.lineTo(mid + 5, box.height - 1);
    c.lineTo(mid, box.height - 8);
    c.fill();
}

let rulerDrag = null;
ruler.addEventListener('pointerdown', (event) => {
    if (event.target.id === 'ed-angle-input') return;
    ruler.setPointerCapture(event.pointerId);
    rulerDrag = { x: event.clientX, angle: state.recipe.geometry.angle, fine: event.shiftKey };
});
ruler.addEventListener('pointermove', (event) => {
    if (!rulerDrag) return;
    if (event.shiftKey !== rulerDrag.fine) rulerDrag = { x: event.clientX, angle: state.recipe.geometry.angle, fine: event.shiftKey };
    const dx = event.clientX - rulerDrag.x;
    const perDeg = rulerDrag.fine ? PX_PER_DEG * 10 : PX_PER_DEG;
    setAngle(rulerDrag.angle - dx / perDeg, { fine: rulerDrag.fine });
});
const stopRulerDrag = () => {
    if (!rulerDrag) return;
    rulerDrag = null;
    endStraighten();
};
ruler.addEventListener('pointerup', stopRulerDrag);
ruler.addEventListener('pointercancel', stopRulerDrag);
let wheelTimer;
ruler.addEventListener('wheel', (event) => {
    event.preventDefault();
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    setAngle(state.recipe.geometry.angle + (delta > 0 ? -0.1 : 0.1), { fine: true });
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(endStraighten, 400);
}, { passive: false });
ruler.addEventListener('keydown', (event) => {
    const a = state.recipe.geometry.angle;
    const step = event.shiftKey ? 0.1 : 1;
    const map = { ArrowLeft: a - step, ArrowDown: a - step, ArrowRight: a + step, ArrowUp: a + step, PageUp: a + 5, PageDown: a - 5, Home: -MAX_ANGLE, End: MAX_ANGLE };
    if (!(event.key in map)) return;
    event.preventDefault();
    setAngle(map[event.key], { fine: event.shiftKey || !Number.isInteger(a) });
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(endStraighten, 400);
});
$('ed-angle').addEventListener('dblclick', () => {
    const input = $('ed-angle-input');
    input.value = String(state.recipe.geometry.angle);
    input.hidden = false;
    $('ed-angle').hidden = true;
    input.focus();
    input.select();
});
$('ed-angle-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === 'Escape') {
        if (event.key === 'Enter' && Number.isFinite(Number(event.target.value))) {
            setAngle(Number(event.target.value), { fine: true });
            endStraighten();
        }
        event.target.hidden = true;
        $('ed-angle').hidden = false;
        ruler.focus();
    }
});
$('ed-angle-input').addEventListener('blur', (event) => {
    event.target.hidden = true;
    $('ed-angle').hidden = false;
});

$('ed-rotate90').addEventListener('click', () => {
    const g = state.recipe.geometry;
    g.rotate90 = (g.rotate90 + 3) % 4; // counter-clockwise, like Google Photos
    g.crop = null;
    initCrop();
    commitCrop();
    draw();
});

$('ed-crop-reset').addEventListener('click', () => {
    const g = state.recipe.geometry;
    g.rotate90 = 0;
    g.angle = 0;
    g.aspect = 'free';
    g.crop = null;
    initCrop();
    updateRuler();
    renderCropPanel();
    updateDirty();
});

canvas.addEventListener('pointerdown', onCropPointerDown);
canvas.addEventListener('pointermove', onCropPointerMove);
canvas.addEventListener('pointerup', onCropPointerUp);
canvas.addEventListener('pointercancel', onCropPointerUp);
canvas.addEventListener('pointermove', (event) => {
    if (state.tab !== 'crop' || !state.crop || state.crop.drag) return;
    const box = canvas.getBoundingClientRect();
    const hit = hitHandle(event.clientX - box.left, event.clientY - box.top);
    canvas.style.cursor = hit === null ? 'default' : hit === 'pan' ? 'move' : (hit === 0 || hit === 3) ? 'nwse-resize' : 'nesw-resize';
});

// ---- Panels -----------------------------------------------------------------

function element(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
}

function renderCropPanel() {
    const panel = $('panel-crop');
    const g = state.recipe.geometry;
    panel.replaceChildren(
        element('h3', { class: 'section-title', text: 'Aspect Ratio' }),
        element('div', { class: 'aspect-grid' }, ASPECTS.map(([id, label, ratio]) => element('button', {
            type: 'button',
            class: `aspect-button${g.aspect === id ? ' selected' : ''}`,
            'aria-pressed': String(g.aspect === id),
            onclick: () => setAspect(id),
        }, [aspectIcon(id, ratio), element('span', { text: label })]))),
    );
}

function aspectIcon(id, ratio) {
    const r = id === 'original' && state.proxy ? state.proxy.width / state.proxy.height : ratio ?? 1;
    const w = r >= 1 ? 18 : 18 * r;
    const h = r >= 1 ? 18 / r : 18;
    const icon = element('span', { class: `aspect-icon${id === 'free' ? ' free' : ''}`, 'aria-hidden': 'true' });
    icon.style.width = `${w}px`;
    icon.style.height = `${h}px`;
    return element('span', { class: 'aspect-circle' }, icon);
}

function setAspect(id) {
    const g = state.recipe.geometry;
    g.aspect = id;
    const { width: W, height: H } = orientedDims();
    const ratio = currentAspect();
    if (ratio) {
        const c = state.crop;
        const max = maxRectAt(W, H, g.angle, ratio, c.rect.cx, c.rect.cy);
        const centred = maxRectAt(W, H, g.angle, ratio);
        const size = max.w > centred.w * 0.7 ? max : centred;
        const cx = max === size ? c.rect.cx : W / 2;
        const cy = max === size ? c.rect.cy : H / 2;
        c.rect = constrainRect({ cx, cy, w: size.w, h: size.h }, W, H, g.angle);
    }
    fitFrame(true);
    commitCrop();
    renderCropPanel();
}

function renderAdjustPanel() {
    const panel = $('panel-adjust');
    const groups = [ADJUST_KEYS.slice(0, 7), ADJUST_KEYS.slice(7, 12), ADJUST_KEYS.slice(12)];
    panel.replaceChildren(...groups.map(keys => element('div', { class: 'slider-group' }, keys.map(sliderRow))));
}

function sliderRow(key) {
    const value = state.recipe.adjust[key];
    const min = UNIPOLAR.has(key) ? 0 : -1;
    const input = element('input', {
        type: 'range', min: String(min), max: '1', step: '0.01', value: String(value),
        'aria-label': ADJUST_LABELS[key], class: min === 0 ? 'unipolar' : 'bipolar',
    });
    const output = element('output', { class: 'slider-value', text: formatValue(value) });
    const row = element('div', { class: `slider-row${value ? ' active' : ''}` }, [
        element('label', { class: 'slider-label', text: ADJUST_LABELS[key] }), output, input,
    ]);
    const update = () => {
        const v = Number(input.value);
        state.recipe.adjust[key] = v;
        output.textContent = formatValue(v);
        row.classList.toggle('active', v !== 0);
        paintRange(input);
        requestRender();
    };
    input.addEventListener('input', update);
    input.addEventListener('dblclick', () => {
        input.value = '0';
        update();
    });
    paintRange(input);
    return row;
}

const formatValue = v => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}`);

// Fill the track from the neutral point to the thumb, like Google's sliders
function paintRange(input) {
    const min = Number(input.min);
    const v = Number(input.value);
    const pos = ((v - min) / (1 - min)) * 100;
    const zero = ((0 - min) / (1 - min)) * 100;
    const [a, b] = pos < zero ? [pos, zero] : [zero, pos];
    input.style.setProperty('--fill-start', `${a}%`);
    input.style.setProperty('--fill-end', `${b}%`);
}

let filterThumbs = null;
async function renderFiltersPanel() {
    const panel = $('panel-filters');
    const ids = Object.keys(FILTERS);
    const current = state.recipe.filter;
    const grid = element('div', { class: 'filter-grid' }, ids.map(id => {
        const selected = current.id === id;
        const thumb = element('canvas', { class: 'filter-thumb', 'aria-hidden': 'true' });
        thumb.dataset.filter = id;
        return element('button', {
            type: 'button', class: `filter-button${selected ? ' selected' : ''}`, 'aria-pressed': String(selected),
            onclick: () => selectFilter(id),
        }, [thumb, element('span', { text: FILTERS[id].name })]);
    }));
    const children = [grid];
    if (current.id !== 'none') {
        const input = element('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(current.strength), 'aria-label': 'Filter strength', class: 'unipolar' });
        paintRange(input);
        input.addEventListener('input', () => {
            state.recipe.filter.strength = Number(input.value);
            paintRange(input);
            requestRender();
        });
        children.unshift(element('div', { class: 'slider-row active' }, [element('label', { class: 'slider-label', text: `${FILTERS[current.id].name} strength` }), input]));
    }
    panel.replaceChildren(...children);
    if (!filterThumbs) {
        // Thumbnails show each filter on top of the current adjustments
        const base = normalizeRecipe({ ...state.recipe, filter: { id: 'none', strength: 1 } });
        const result = await call('thumbs', { recipes: ids.map(id => ({ ...base, filter: { id, strength: 1 } })) });
        filterThumbs = await Promise.all(result.results.map(toBitmap));
    }
    panel.querySelectorAll('canvas.filter-thumb').forEach((c, i) => {
        const bmp = filterThumbs[i];
        const size = 72;
        c.width = size * 2;
        c.height = size * 2;
        const g = c.getContext('2d');
        const s = Math.max(c.width / bmp.width, c.height / bmp.height);
        g.drawImage(bmp, (c.width - bmp.width * s) / 2, (c.height - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
    });
}

function selectFilter(id) {
    const f = state.recipe.filter;
    if (f.id !== id) state.recipe.filter = { id, strength: 1 };
    renderFiltersPanel();
    requestRender();
}

function renderSuggestionsPanel() {
    const panel = $('panel-suggestions');
    const autos = state.stats ? autoRecipes(state.stats) : {};
    panel.replaceChildren(
        element('h3', { class: 'section-title', text: 'Suggestions' }),
        element('div', { class: 'suggestion-list' }, Object.entries(autos).map(([id, auto]) => element('button', {
            type: 'button', class: 'suggestion-button',
            onclick: () => applyAuto(auto),
        }, [element('span', { class: 'suggestion-icon', 'aria-hidden': 'true', text: '✦' }), element('span', { text: auto.name })]))),
    );
}

function applyAuto(auto) {
    // Like Google: a suggestion replaces the tone settings but keeps crop and filter
    state.recipe.adjust = { ...defaultRecipe().adjust, ...auto.adjust };
    filterThumbs = null;
    requestRender();
}

function renderToolsPanel() {
    $('panel-tools').replaceChildren(element('p', { class: 'panel-note', text: 'Sky, Color focus, Portrait light and Blur arrive in the next step.' }));
}

const PANELS = { suggestions: renderSuggestionsPanel, crop: renderCropPanel, tools: renderToolsPanel, adjust: renderAdjustPanel, filters: renderFiltersPanel };

function selectTab(tab) {
    const leavingCrop = state.tab === 'crop' && tab !== 'crop';
    state.tab = tab;
    document.querySelectorAll('[role=tab]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
    document.querySelectorAll('[role=tabpanel]').forEach(p => { p.hidden = p.id !== `panel-${tab}`; });
    $('ed-ruler-bar').hidden = tab !== 'crop';
    if (tab === 'crop') {
        initCrop();
        updateRuler();
    } else if (leavingCrop) {
        state.crop = null;
        filterThumbs = null;
    }
    if (tab === 'filters') filterThumbs = null;
    PANELS[tab]();
    requestAnimationFrame(resizeCanvas);
    requestRender();
}

document.querySelectorAll('[role=tab]').forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));

// ---- Dirty state, leaving, saving --------------------------------------------

const isDirty = () => !recipesEqual(state.recipe, state.initial);

function updateDirty() {
    $('ed-save').disabled = !isDirty() || state.saving;
}

window.addEventListener('beforeunload', (event) => {
    if (isDirty() && !state.saving) {
        event.preventDefault();
        event.returnValue = '';
    }
});

function leave() {
    location.href = '/';
}

$('ed-close').addEventListener('click', () => {
    if (isDirty()) $('ed-discard-dialog').showModal();
    else leave();
});
$('ed-keep').addEventListener('click', () => $('ed-discard-dialog').close());
$('ed-discard').addEventListener('click', () => {
    state.recipe = normalizeRecipe(state.initial);
    $('ed-discard-dialog').close();
    leave();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]') && document.activeElement?.tagName !== 'INPUT') $('ed-close').click();
});

async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
        credentials: 'same-origin',
    });
    if (response.status === 401) {
        location.href = `/auth/login?return=${encodeURIComponent(location.pathname)}`;
        throw new Error('Signed out');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
}

$('ed-save').addEventListener('click', async () => {
    if (!isDirty() || state.saving) return;
    state.saving = true;
    updateDirty();
    const overlay = $('ed-saving');
    overlay.hidden = false;
    $('ed-saving-text').textContent = 'Saving…';
    try {
        const { jobId } = await api(`/api/edit/${state.context.original.id}/save`, { method: 'POST', body: JSON.stringify({ recipe: state.recipe, source: state.source ?? 'manual' }) });
        for (;;) {
            await new Promise(r => setTimeout(r, 800));
            const job = await api(`/api/jobs/${jobId}`);
            $('ed-saving-text').textContent = `${job.step}…`;
            if (job.status === 'done') break;
            if (job.status === 'error') throw new Error(job.error || 'Saving failed');
        }
        state.initial = normalizeRecipe(state.recipe);
        leave();
    } catch (error) {
        overlay.hidden = true;
        state.saving = false;
        updateDirty();
        alertInline(`Couldn't save: ${error.message}`);
    }
});

function alertInline(message) {
    statusEl.textContent = message;
    statusEl.hidden = false;
    setTimeout(() => { statusEl.hidden = true; }, 6000);
}

// ---- Versions -----------------------------------------------------------------

function renderVersions() {
    const ctx = state.context;
    $('ed-versions').hidden = !ctx.edits.length;
    const list = $('ed-versions-list');
    const rows = [{ id: null, label: 'Original', assetId: ctx.original.id, summary: 'As taken' }]
        .concat(ctx.edits.map((e, i) => ({ id: e.id, label: `Edit ${i + 1}`, assetId: e.renderedAssetId, summary: e.summary, source: e.source })));
    list.replaceChildren(...rows.map(row => {
        const shown = (row.id ?? null) === (ctx.shownEditId ?? null);
        const actions = [];
        if (!shown) actions.push(element('button', { type: 'button', class: 'text-button', text: 'Show this', onclick: () => versionAction('show', row.id) }));
        if (row.id) actions.push(element('button', { type: 'button', class: 'text-button danger', text: 'Discard', onclick: () => versionAction('discard', row.id) }));
        return element('li', { class: `version${shown ? ' shown' : ''}` }, [
            element('img', { src: `/media/${row.assetId}/thumbnail`, alt: '', loading: 'lazy' }),
            element('div', { class: 'version-text' }, [
                element('strong', { text: `${row.label}${shown ? ' · shown' : ''}${row.source === 'suggestion' ? ' · suggestion' : ''}` }),
                element('span', { text: row.summary }),
            ]),
            element('div', { class: 'version-actions' }, actions),
        ]);
    }));
}

async function versionAction(kind, editId) {
    const id = state.context.original.id;
    try {
        if (kind === 'show') await api(`/api/edit/${id}/show`, { method: 'POST', body: JSON.stringify({ editId }) });
        else if (kind === 'discard') await api(`/api/edit/${id}/discard`, { method: 'POST', body: JSON.stringify(editId === 'all' ? { all: true } : { editId }) });
        await loadContext(false);
        renderVersions();
        if (!state.context.edits.length) $('ed-versions-dialog').close();
    } catch (error) {
        alertInline(error.message);
    }
}

$('ed-versions').addEventListener('click', () => {
    renderVersions();
    $('ed-versions-dialog').showModal();
});
$('ed-versions-close').addEventListener('click', () => $('ed-versions-dialog').close());
$('ed-discard-all').addEventListener('click', () => versionAction('discard', 'all'));

// ---- Start ----------------------------------------------------------------------

async function loadContext(resetRecipe = true) {
    state.context = await api(`/api/edit/${assetId}`);
    if (resetRecipe) {
        state.initial = normalizeRecipe(state.context.recipe);
        state.recipe = normalizeRecipe(state.context.recipe);
    }
    renderVersions();
}

async function start() {
    try {
        await loadContext();
        if (!state.context.editable) {
            statusEl.textContent = 'Only photos can be edited.';
            return;
        }
        const loaded = await call('load', { url: `/media/${state.context.original.id}/preview` });
        state.proxy = { width: loaded.width, height: loaded.height };
        state.stats = loaded.stats;
        statusEl.hidden = true;
        selectTab(new URLSearchParams(location.search).get('tab') || 'adjust');
    } catch (error) {
        statusEl.textContent = `Couldn't open the photo: ${error.message}`;
    }
}

new ResizeObserver(() => resizeCanvas()).observe(stage);
window.addEventListener('resize', () => { if (state.tab === 'crop') updateRuler(); });
start();
