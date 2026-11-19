// The "Advanced" tab: Lightroom-style controls on top of the simple Adjust sliders.
import { CURVE_CHANNELS, GRADING_REGIONS, HSL_BANDS, curveLut, defaultAdvanced } from './advanced.js';

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
}

function paint(input, neutral) {
    const min = Number(input.min), max = Number(input.max), v = Number(input.value);
    const pos = ((v - min) / (max - min)) * 100;
    const zero = ((neutral - min) / (max - min)) * 100;
    input.style.setProperty('--fill-start', `${Math.min(pos, zero)}%`);
    input.style.setProperty('--fill-end', `${Math.max(pos, zero)}%`);
}

// A labelled slider; `get`/`set` read and write the recipe value
function slider(label, { min, max, step = 0.01, neutral = 0, get, set, format = v => (Math.round(v * 100) / 100).toString(), onChange }) {
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()), 'aria-label': label });
    const out = el('output', { class: 'slider-value', text: format(get()) });
    const row = el('div', { class: `slider-row${get() !== neutral ? ' active' : ''}` }, [el('label', { class: 'slider-label', text: label }), out, input]);
    paint(input, neutral);
    const update = () => {
        const v = Number(input.value);
        set(v);
        out.textContent = format(v);
        row.classList.toggle('active', v !== neutral);
        paint(input, neutral);
        onChange();
    };
    input.addEventListener('input', update);
    input.addEventListener('dblclick', () => { input.value = String(neutral); update(); });
    return row;
}

function section(title, open, children) {
    return el('details', { class: 'adv-section', ...(open ? { open: true } : {}) }, [el('summary', { text: title }), ...children]);
}

let curveChannel = 'rgb';
let hslBand = 'blue';
const openSections = new Set(['Light']);

export function renderAdvancedPanel(panel, recipe, onChange) {
    if (!recipe.advanced) recipe.advanced = defaultAdvanced();
    const a = recipe.advanced;
    const rerender = () => renderAdvancedPanel(panel, recipe, onChange);
    const pct = v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;

    const light = [
        slider('Exposure', { min: -3, max: 3, step: 0.05, get: () => a.exposure, set: v => { a.exposure = v; }, format: v => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`, onChange }),
        slider('Clarity', { min: -1, max: 1, get: () => a.clarity, set: v => { a.clarity = v; }, format: pct, onChange }),
        slider('Dehaze', { min: -1, max: 1, get: () => a.dehaze, set: v => { a.dehaze = v; }, format: pct, onChange }),
    ];

    const lv = a.levels;
    const levels = [
        slider('Input black', { min: 0, max: 0.5, get: () => lv.inBlack, set: v => { lv.inBlack = v; }, format: v => Math.round(v * 255), onChange }),
        slider('Input white', { min: 0.5, max: 1, neutral: 1, get: () => lv.inWhite, set: v => { lv.inWhite = v; }, format: v => Math.round(v * 255), onChange }),
        slider('Gamma', { min: 0.2, max: 5, step: 0.05, neutral: 1, get: () => lv.gamma, set: v => { lv.gamma = v; }, format: v => v.toFixed(2), onChange }),
        slider('Output black', { min: 0, max: 0.5, get: () => lv.outBlack, set: v => { lv.outBlack = v; }, format: v => Math.round(v * 255), onChange }),
        slider('Output white', { min: 0.5, max: 1, neutral: 1, get: () => lv.outWhite, set: v => { lv.outWhite = v; }, format: v => Math.round(v * 255), onChange }),
    ];

    // Curves: click to add a point, drag to move, double-click a point to remove it
    const canvas = el('canvas', { class: 'curve-canvas', width: '520', height: '520', 'aria-label': `Tone curve (${curveChannel})` });
    const colours = { rgb: '#e3e3e8', r: '#ff6b6b', g: '#69db7c', b: '#74c0fc' };
    const drawCurve = () => {
        const g = canvas.getContext('2d');
        const s = canvas.width;
        g.clearRect(0, 0, s, s);
        g.strokeStyle = 'rgba(255,255,255,0.12)';
        for (let i = 1; i < 4; i++) {
            g.beginPath(); g.moveTo((s * i) / 4, 0); g.lineTo((s * i) / 4, s); g.moveTo(0, (s * i) / 4); g.lineTo(s, (s * i) / 4); g.stroke();
        }
        g.strokeStyle = 'rgba(255,255,255,0.25)';
        g.beginPath(); g.moveTo(0, s); g.lineTo(s, 0); g.stroke();
        for (const ch of CURVE_CHANNELS) {
            if (ch !== curveChannel && !a.curves[ch].length) continue;
            const lut = curveLut(a.curves[ch]);
            g.strokeStyle = colours[ch];
            g.globalAlpha = ch === curveChannel ? 1 : 0.35;
            g.lineWidth = ch === curveChannel ? 3 : 2;
            g.beginPath();
            for (let k = 0; k <= 1024; k += 4) {
                const x = (k / 1024) * s, y = s - lut[k] * s;
                if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.stroke();
        }
        g.globalAlpha = 1;
        g.fillStyle = colours[curveChannel];
        for (const [x, y] of a.curves[curveChannel]) {
            g.beginPath(); g.arc(x * s, s - y * s, 9, 0, Math.PI * 2); g.fill();
        }
    };
    let dragging = -1;
    const pos = (e) => {
        const r = canvas.getBoundingClientRect();
        return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
    };
    const nearest = ([x, y]) => a.curves[curveChannel].findIndex(([px, py]) => Math.hypot(px - x, py - y) < 0.04);
    canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        const p = pos(e);
        dragging = nearest(p);
        if (dragging < 0 && a.curves[curveChannel].length < 16) {
            a.curves[curveChannel].push(p);
            a.curves[curveChannel].sort((q, w) => q[0] - w[0]);
            dragging = a.curves[curveChannel].findIndex(q => q === p);
        }
        drawCurve();
        onChange();
    });
    canvas.addEventListener('pointermove', (e) => {
        if (dragging < 0) return;
        const pts = a.curves[curveChannel];
        const [x, y] = pos(e);
        const lo = dragging > 0 ? pts[dragging - 1][0] + 0.01 : 0;
        const hi = dragging < pts.length - 1 ? pts[dragging + 1][0] - 0.01 : 1;
        pts[dragging] = [Math.min(hi, Math.max(lo, x)), y];
        drawCurve();
        onChange();
    });
    canvas.addEventListener('pointerup', () => { dragging = -1; });
    canvas.addEventListener('dblclick', (e) => {
        const i = nearest(pos(e));
        if (i >= 0) a.curves[curveChannel].splice(i, 1);
        drawCurve();
        onChange();
    });
    requestAnimationFrame(drawCurve);
    const curves = [
        el('div', { class: 'chip-row' }, CURVE_CHANNELS.map(ch => el('button', {
            type: 'button', class: `chip${ch === curveChannel ? ' selected' : ''}`, 'aria-pressed': String(ch === curveChannel),
            text: ch === 'rgb' ? 'RGB' : ch.toUpperCase(), onclick: () => { curveChannel = ch; rerender(); },
        }))),
        canvas,
        el('div', { class: 'adv-actions' }, [
            el('p', { class: 'panel-note', text: 'Click to add a point, drag to move, double-click to remove' }),
            el('button', { type: 'button', class: 'text-button', text: 'Reset curve', onclick: () => { a.curves[curveChannel] = []; rerender(); onChange(); } }),
        ]),
    ];

    const band = a.hsl[hslBand];
    const hsl = [
        el('div', { class: 'chip-row' }, HSL_BANDS.map(([name, hue]) => {
            const chip = el('button', {
                type: 'button', class: `hue-chip${name === hslBand ? ' selected' : ''}`, 'aria-pressed': String(name === hslBand), 'aria-label': name, title: name,
                onclick: () => { hslBand = name; rerender(); },
            });
            chip.style.background = `hsl(${hue} 75% 55%)`;
            return chip;
        })),
        slider(`Hue (${hslBand})`, { min: -1, max: 1, get: () => band.h, set: v => { band.h = v; }, format: v => `${v > 0 ? '+' : ''}${Math.round(v * 30)}°`, onChange }),
        slider(`Saturation (${hslBand})`, { min: -1, max: 1, get: () => band.s, set: v => { band.s = v; }, format: pct, onChange }),
        slider(`Luminance (${hslBand})`, { min: -1, max: 1, get: () => band.l, set: v => { band.l = v; }, format: pct, onChange }),
    ];

    const gr = a.grading;
    const grading = [
        ...GRADING_REGIONS.flatMap(region => {
            const r = gr[region];
            const name = region[0].toUpperCase() + region.slice(1);
            const hue = slider(`${name} hue`, { min: 0, max: 360, step: 1, neutral: defaultAdvanced().grading[region].hue, get: () => r.hue, set: v => { r.hue = v; }, format: v => `${Math.round(v)}°`, onChange });
            hue.querySelector('input').classList.add('hue-track');
            return [hue, slider(`${name} saturation`, { min: 0, max: 1, get: () => r.sat, set: v => { r.sat = v; }, format: pct, onChange })];
        }),
        slider('Balance', { min: -1, max: 1, get: () => gr.balance, set: v => { gr.balance = v; }, format: pct, onChange }),
        slider('Blending', { min: 0, max: 1, neutral: 0.5, get: () => gr.blending, set: v => { gr.blending = v; }, format: pct, onChange }),
    ];

    const detail = [
        slider('Sharpen', { min: 0, max: 1, get: () => a.sharpen.amount, set: v => { a.sharpen.amount = v; }, format: pct, onChange }),
        slider('Sharpen radius', { min: 0.5, max: 3, step: 0.1, neutral: 1, get: () => a.sharpen.radius, set: v => { a.sharpen.radius = v; }, format: v => v.toFixed(1), onChange }),
        slider('Noise reduction', { min: 0, max: 1, get: () => a.noise, set: v => { a.noise = v; }, format: pct, onChange }),
        slider('Grain', { min: 0, max: 1, get: () => a.grain, set: v => { a.grain = v; }, format: pct, onChange }),
    ];

    const vg = a.vignette;
    const vignette = [
        slider('Amount', { min: -1, max: 1, get: () => vg.amount, set: v => { vg.amount = v; }, format: pct, onChange }),
        slider('Midpoint', { min: 0, max: 1, neutral: 0.5, get: () => vg.midpoint, set: v => { vg.midpoint = v; }, format: pct, onChange }),
        slider('Roundness', { min: -1, max: 1, get: () => vg.roundness, set: v => { vg.roundness = v; }, format: pct, onChange }),
        slider('Feather', { min: 0, max: 1, neutral: 0.5, get: () => vg.feather, set: v => { vg.feather = v; }, format: pct, onChange }),
    ];

    const sections = [['Light', light], ['Levels', levels], ['Curves', curves], ['HSL', hsl], ['Color grading', grading], ['Detail', detail], ['Vignette', vignette]]
        .map(([title, children]) => {
            const d = section(title, openSections.has(title), children);
            d.addEventListener('toggle', () => (d.open ? openSections.add(title) : openSections.delete(title)));
            return d;
        });
    panel.replaceChildren(...sections, el('button', {
        type: 'button', class: 'pill-button adv-reset', text: 'Reset advanced',
        onclick: () => { recipe.advanced = defaultAdvanced(); rerender(); onChange(); },
    }));
}
