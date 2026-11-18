import { estimateMonthHeight, formatDateTime, formatDay, formatDuration, groupByDay, justify, localTime } from './layout.js';

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>';
const STACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm4-4h12a2 2 0 0 1 2 2v10a2 2 0 0 1-1 1.73V5H8.27A2 2 0 0 1 8 3Z"/></svg>';

const timeline = document.getElementById('timeline');
const statusEl = document.getElementById('status');
const narrow = window.matchMedia('(max-width: 640px)');
const metrics = () => (narrow.matches ? { rowHeight: 120, gap: 2, header: 44 } : { rowHeight: 235, gap: 4, header: 52 });

const months = [];
let lastWidth = 0;

function signIn() {
    location.href = `/auth/login?return=${encodeURIComponent(location.pathname)}`;
}

async function getJson(url) {
    const response = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (response.status === 401) {
        signIn();
        throw new Error('Signed out');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function innerWidth() {
    const style = getComputedStyle(timeline);
    return Math.floor(timeline.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
}

function monthLabel(month) {
    return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
}

// ---- Timeline -------------------------------------------------------------

function tile(month, index, width, height) {
    const { data } = month;
    const id = data.id[index];
    const isImage = data.isImage[index];
    const link = element('a', 'tile');
    link.href = `#asset=${id}`;
    link.dataset.month = String(month.index);
    link.dataset.asset = String(index);
    link.style.width = `${width}px`;
    link.style.height = `${height}px`;
    link.setAttribute('aria-label', `${isImage ? 'Photo' : 'Video'}, ${formatDateTime(localTime(data.fileCreatedAt[index], data.localOffsetHours[index]))}`);

    const image = new Image();
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.draggable = false;
    image.addEventListener('load', () => link.classList.add('ready'), { once: true });
    image.src = `/media/${id}/thumbnail`;
    link.append(image);

    if (!isImage) {
        const badge = element('span', 'badge badge-video');
        badge.innerHTML = PLAY_ICON;
        badge.append(formatDuration(data.duration[index]));
        link.append(badge);
    }
    if (data.stackCount[index] > 1) {
        const badge = element('span', 'badge badge-stack');
        badge.innerHTML = STACK_ICON;
        badge.append(String(data.stackCount[index]));
        link.append(badge);
    }
    return link;
}

function renderMonth(month) {
    const { rowHeight, gap, header } = metrics();
    const width = innerWidth();
    const fragment = document.createDocumentFragment();
    for (const day of month.days) {
        const section = element('section', 'day');
        section.append(element('h2', 'day-title', formatDay(day.date)));
        const rows = justify(day.indices.map(i => month.data.ratio[i]), width, rowHeight, gap);
        // Like Immich, days that fit in a single partial row only take their own width,
        // so several small days share a line
        const dayWidth = rows.some(row => row.filled)
            ? width
            : rows[0].items.reduce((sum, item) => sum + item.width, 0) + gap * (rows[0].items.length - 1);
        let height = header;
        for (const row of rows) {
            const rowEl = element('div', 'row');
            rowEl.style.height = `${row.height}px`;
            for (const item of row.items) rowEl.append(tile(month, day.indices[item.index], item.width, row.height));
            section.append(rowEl);
            height += row.height + gap;
        }
        section.style.width = `${dayWidth}px`;
        // Off-screen days skip rendering but keep their exact size
        section.style.containIntrinsicSize = `auto ${dayWidth}px auto ${height}px`;
        fragment.append(section);
    }
    const focused = month.section.contains(document.activeElement) ? document.activeElement.dataset.asset : null;
    month.section.replaceChildren(fragment);
    month.section.style.height = '';
    month.section.classList.add('loaded');
    if (focused !== null) month.section.querySelector(`a.tile[data-asset="${focused}"]`)?.focus({ preventScroll: true });
}

function renderPlaceholder(month) {
    const { rowHeight, gap, header } = metrics();
    month.section.style.height = `${estimateMonthHeight(month.count, innerWidth(), rowHeight, gap, header)}px`;
}

function renderMonthError(month) {
    const retry = element('button', 'button', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => loadMonth(month).catch(() => {}));
    const box = element('div', 'month-error');
    box.append(element('p', '', `Couldn't load ${monthLabel(month.month)}.`), retry);
    month.section.replaceChildren(box);
}

function loadMonth(month) {
    if (month.data) return Promise.resolve(month);
    if (!month.loading) {
        month.loading = getJson(`/api/timeline/bucket?month=${month.month}`)
            .then((data) => {
                month.data = data;
                month.days = groupByDay(data);
                observer.unobserve(month.section);
                renderMonth(month);
                return month;
            })
            .catch((error) => {
                renderMonthError(month);
                throw error;
            })
            .finally(() => {
                month.loading = null;
            });
    }
    return month.loading;
}

const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        if (entry.isIntersecting) loadMonth(months[Number(entry.target.dataset.index)]).catch(() => {});
    }
}, { rootMargin: '200% 0px' });

function relayout(force = false) {
    const width = innerWidth();
    if (!force && width === lastWidth) return;
    lastWidth = width;
    for (const month of months) {
        if (month.data) renderMonth(month);
        else if (!month.section.querySelector('.month-error')) renderPlaceholder(month);
    }
}

let resizeTimer;
new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => relayout(), 150);
}).observe(timeline);
narrow.addEventListener('change', () => relayout(true));

timeline.addEventListener('click', (event) => {
    const link = event.target.closest('a.tile');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    openViewer(Number(link.dataset.month), Number(link.dataset.asset));
});

// ---- Suggestions greeting ------------------------------------------------------

async function postJson(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body ?? {}) });
    if (response.status === 401) {
        signIn();
        throw new Error('Signed out');
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
    return json;
}

async function waitForJob(jobId, onStep) {
    for (;;) {
        await new Promise(r => setTimeout(r, 900));
        const job = await getJson(`/api/jobs/${jobId}`);
        onStep?.(job.step);
        if (job.status === 'done') return job;
        if (job.status === 'error') throw new Error(job.error || 'Saving failed');
    }
}

function suggestionCard(item) {
    const card = element('article', 'suggestion-card');
    const figure = element('div', 'suggestion-figure');
    const img = element('img');
    img.alt = `${item.name}: suggested edit`;
    img.src = `/api/suggestions/${item.id}/after`;
    img.loading = 'lazy';
    const compare = element('button', 'compare-button', 'Hold to compare');
    compare.type = 'button';
    const showBefore = (on) => {
        img.src = `/api/suggestions/${item.id}/${on ? 'before' : 'after'}`;
        compare.textContent = on ? 'Original' : 'Hold to compare';
    };
    compare.addEventListener('pointerdown', () => showBefore(true));
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) compare.addEventListener(ev, () => showBefore(false));
    figure.append(img, compare);
    const body = element('div', 'suggestion-body');
    body.append(element('h3', '', item.name), element('p', 'suggestion-why', item.why ? `Why: ${item.why}` : item.summary));
    const actions = element('div', 'suggestion-actions');
    const apply = element('button', 'button', 'Apply');
    const edit = element('a', 'text-link', 'Edit');
    const dismiss = element('button', 'text-button', 'Dismiss');
    apply.type = 'button';
    dismiss.type = 'button';
    edit.href = `/edit/${item.assetId}?suggestion=${item.id}`;
    apply.addEventListener('click', async () => {
        apply.disabled = true;
        dismiss.disabled = true;
        try {
            const { jobId } = await postJson(`/api/suggestions/${item.id}/apply`);
            await waitForJob(jobId, step => { apply.textContent = `${step}…`; });
            actions.replaceChildren(element('span', 'suggestion-done', 'Saved as a new version'));
        } catch (error) {
            apply.disabled = false;
            dismiss.disabled = false;
            apply.textContent = 'Apply';
            body.append(element('p', 'suggestion-error', error.message));
        }
    });
    dismiss.addEventListener('click', async () => {
        await postJson(`/api/suggestions/${item.id}/dismiss`).catch(() => {});
        card.remove();
        if (!document.querySelector('.suggestion-card')) document.querySelector('.greeting')?.remove();
    });
    actions.append(apply, edit, dismiss);
    body.append(actions);
    card.append(figure, body);
    return card;
}

async function loadGreeting() {
    try {
        const greeting = await getJson('/api/suggestions');
        if (!greeting.suggestions?.length) return;
        const section = element('section', 'greeting');
        section.setAttribute('aria-label', 'Suggested edits');
        section.append(element('h2', 'greeting-title', greeting.text));
        const row = element('div', 'greeting-cards');
        greeting.suggestions.forEach(item => row.append(suggestionCard(item)));
        section.append(row);
        timeline.prepend(section);
    } catch {
        // Suggestions are optional; the timeline works without them
    }
}

async function init() {
    if (location.hash.startsWith('#asset=')) history.replaceState(null, '', location.pathname);
    loadGreeting();
    try {
        const buckets = await getJson('/api/timeline/buckets');
        if (!buckets.length) {
            statusEl.textContent = 'No photos yet';
            return;
        }
        statusEl.remove();
        lastWidth = innerWidth();
        buckets.forEach(({ month, count }, index) => {
            const section = element('section', 'month');
            section.dataset.index = String(index);
            section.setAttribute('aria-label', monthLabel(month));
            const entry = { index, month, count, section, data: null, days: [], loading: null };
            months.push(entry);
            renderPlaceholder(entry);
            timeline.append(section);
            observer.observe(section);
        });
    } catch {
        statusEl.textContent = "Couldn't load your photos. ";
        const retry = element('a', '', 'Try again');
        retry.href = '/';
        statusEl.append(retry);
    } finally {
        timeline.removeAttribute('aria-busy');
    }
}

// ---- Viewer ---------------------------------------------------------------

const viewer = {
    root: document.getElementById('viewer'),
    image: document.getElementById('viewer-image'),
    caption: document.getElementById('viewer-caption'),
    play: document.getElementById('viewer-play'),
    prev: document.getElementById('viewer-prev'),
    next: document.getElementById('viewer-next'),
    close: document.getElementById('viewer-close'),
    edit: document.getElementById('viewer-edit'),
    current: null,
    request: 0,
};

const assetId = ({ month, index }) => months[month].data.id[index];

function preload(month, index) {
    const data = months[month]?.data;
    if (data && index >= 0 && index < data.id.length) new Image().src = `/media/${data.id[index]}/preview`;
}

// Every listed month holds at least one asset, so the ends are the first and last month
const isFirst = ({ month, index }) => month === 0 && index === 0;
const isLast = ({ month, index }) => month === months.length - 1 && index === months[month].data.id.length - 1;

function show(position) {
    viewer.current = position;
    const { data } = months[position.month];
    const id = data.id[position.index];
    const time = localTime(data.fileCreatedAt[position.index], data.localOffsetHours[position.index]);

    // The cached thumbnail shows at once; the sharp preview replaces it when loaded
    viewer.image.src = `/media/${id}/thumbnail`;
    viewer.image.classList.add('loading');
    const full = new Image();
    full.onload = () => {
        if (viewer.current && assetId(viewer.current) === id) {
            viewer.image.src = full.src;
            viewer.image.classList.remove('loading');
        }
    };
    full.src = `/media/${id}/preview`;

    viewer.caption.textContent = formatDateTime(time);
    viewer.edit.href = `/edit/${id}`;
    viewer.edit.hidden = !data.isImage[position.index];
    viewer.play.hidden = data.isImage[position.index];
    viewer.prev.disabled = isFirst(position);
    viewer.next.disabled = isLast(position);
    preload(position.month, position.index + 1);
    preload(position.month, position.index - 1);
}

function openViewer(month, index) {
    viewer.root.hidden = false;
    document.body.classList.add('viewer-open');
    show({ month, index });
    history.pushState({ viewer: true }, '', `#asset=${assetId(viewer.current)}`);
    viewer.close.focus();
}

function hideViewer() {
    if (viewer.root.hidden) return;
    const id = viewer.current && assetId(viewer.current);
    viewer.root.hidden = true;
    viewer.current = null;
    viewer.request += 1;
    viewer.image.removeAttribute('src');
    document.body.classList.remove('viewer-open');
    const link = id && timeline.querySelector(`a.tile[href="#asset=${id}"]`);
    if (link) {
        link.scrollIntoView({ block: 'nearest' });
        link.focus({ preventScroll: true });
    }
}

function closeViewer() {
    if (history.state?.viewer) history.back();
    else {
        hideViewer();
        history.replaceState(null, '', location.pathname);
    }
}

// Moves through the timeline in Immich's order, loading neighbouring months on demand
async function step(delta) {
    if (!viewer.current) return;
    const request = ++viewer.request;
    let { month, index } = viewer.current;
    index += delta;
    while (index < 0 || index >= months[month].data.id.length) {
        month += index < 0 ? -1 : 1;
        if (month < 0 || month >= months.length) return;
        let loaded;
        try {
            loaded = await loadMonth(months[month]);
        } catch {
            return;
        }
        if (request !== viewer.request) return;
        index = delta < 0 ? loaded.data.id.length - 1 : 0;
    }
    show({ month, index });
    history.replaceState(history.state, '', `#asset=${assetId(viewer.current)}`);
}

viewer.prev.addEventListener('click', () => step(-1));
viewer.next.addEventListener('click', () => step(1));
viewer.close.addEventListener('click', closeViewer);
window.addEventListener('popstate', () => {
    if (!location.hash.startsWith('#asset=')) hideViewer();
});

document.addEventListener('keydown', (event) => {
    if (viewer.root.hidden) return;
    if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'ArrowRight') step(1);
    else if (event.key === 'Escape') closeViewer();
    else return;
    event.preventDefault();
});

// Swipe left/right to browse, down to close
let swipe = null;
viewer.root.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.target.closest('button')) return;
    swipe = { x: event.clientX, y: event.clientY, id: event.pointerId };
});
viewer.root.addEventListener('pointerup', (event) => {
    if (!swipe || event.pointerId !== swipe.id) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    else if (dy > 90 && dy > Math.abs(dx) * 1.5) closeViewer();
});
viewer.root.addEventListener('pointercancel', () => {
    swipe = null;
});

// ---- Account menu ---------------------------------------------------------

const avatar = document.querySelector('.avatar');
const menu = document.getElementById('account-menu');
function setMenu(open) {
    menu.hidden = !open;
    avatar.setAttribute('aria-expanded', String(open));
}
avatar.addEventListener('click', () => setMenu(menu.hidden));
document.addEventListener('click', (event) => {
    if (!menu.hidden && !event.target.closest('.account')) setMenu(false);
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) setMenu(false);
});

init();
