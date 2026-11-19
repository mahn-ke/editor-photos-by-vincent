import { html, toString } from './html.js';

const ICONS = {
    logo: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5Zm2.5-.5a.5.5 0 0 0-.5.5v9.59l3.3-3.3a1 1 0 0 1 1.4 0l1.8 1.8 3.8-3.8a1 1 0 0 1 1.4 0L18 11.9V5.5a.5.5 0 0 0-.5-.5ZM9 9.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z"/></svg>`,
    close: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4Z"/></svg>`,
    prev: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 6.4 14 5l-7 7 7 7 1.4-1.4L9.8 12Z"/></svg>`,
    next: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.6 6.4 1.4-1.4 7 7-7 7-1.4-1.4 5.6-5.6Z"/></svg>`,
    play: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>`,
    edit: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.25V20h2.75L17.8 8.94l-2.75-2.75Zm15.7-10.04a1 1 0 0 0 0-1.41l-1.5-1.5a1 1 0 0 0-1.41 0l-1.13 1.13 2.75 2.75Z"/></svg>`,
    rotate: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.1 8.5 9.5 6H4v5.5l2.06-2.07A7 7 0 1 1 5 13H3a9 9 0 1 0 1.65-5.2Zm4.9-.5h2v5h-2Z"/></svg>`,
    tab_suggestions: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19 9 1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25Zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12ZM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25Z"/></svg>`,
    tab_crop: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 15h2V7a2 2 0 0 0-2-2H9v2h8ZM7 17V1H5v4H1v2h4v10a2 2 0 0 0 2 2h10v4h2v-4h4v-2Z"/></svg>`,
    tab_tools: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.67 18.17-5.3-5.3h-.99l-2.54 2.54v.99l5.3 5.3a1 1 0 0 0 1.41 0l2.12-2.12a1 1 0 0 0 0-1.41ZM17.34 10.19l1.41-1.41 2.12 2.12a3 3 0 0 0 0-4.24l-3.54-3.54-1.41 1.41V1.71l-.7-.71-3.54 3.54.71.71h2.83l-1.41 1.41 1.06 1.06-2.89 2.89-4.13-4.13V5.06L4.83 2.04 2 4.87 5.03 7.9h1.41l4.13 4.13-.85.85H7.6l-5.3 5.3a1 1 0 0 0 0 1.41l2.12 2.12a1 1 0 0 0 1.41 0l5.3-5.3v-2.12l5.15-5.15Z"/></svg>`,
    tab_adjust: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17v2h6v-2Zm0-12v2h10V5Zm10 16v-2h8v-2h-8v-2h-2v6Zm-6-12v2H3v2h4v2h2V9Zm14 4v-2H11v2Zm-6-4h2V7h4V5h-4V3h-2Z"/></svg>`,
    tab_advanced: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h18v-2H3Zm1-4 4.5-6 3.5 4.5 2.5-3L19 16Zm-1-9h4V5H3Zm7 0h11V5H10Z"/></svg>`,
    tab_filters: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm0 16H5V5h14Zm-6.5-8.5L9 15l-2-2.5L4.5 17h15Z"/></svg>`,
};

function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : (parts[0] || '?').slice(0, 2);
    return letters.toUpperCase();
}

function layout({ title, body, bodyClass = '' }) {
    return '<!doctype html>' + toString(html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css">
</head>
<body class="${bodyClass}">
${body}
</body>
</html>`);
}

export function appPage({ name }) {
    return layout({
        title: 'Photos',
        body: html`<header class="topbar">
    <a class="brand" href="/">${ICONS.logo}<span>Photos</span></a>
    <div class="account">
        <button class="avatar" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="account-menu" title="${name}">${initials(name)}</button>
        <div class="menu" id="account-menu" hidden>
            <p class="menu-name">${name}</p>
            <form method="post" action="/background/unstack-raw"><button type="submit" class="menu-secondary">Unstack RAW pairs</button></form>
            <form method="post" action="/background/stop"><button type="submit" class="menu-secondary">Stop background work</button></form>
            <form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>
        </div>
    </div>
</header>
<main id="timeline" class="timeline" aria-busy="true">
    <p class="status" id="status">Loading photos…</p>
</main>
<div class="viewer" id="viewer" role="dialog" aria-modal="true" aria-label="Photo viewer" hidden>
    <img class="viewer-image" id="viewer-image" alt="">
    <span class="viewer-play" id="viewer-play" hidden>${ICONS.play}</span>
    <div class="viewer-bar">
        <p class="viewer-caption" id="viewer-caption"></p>
        <div class="viewer-actions">
            <a class="icon-button" id="viewer-edit" href="#" aria-label="Edit">${ICONS.edit}</a>
            <button class="icon-button" type="button" id="viewer-close" aria-label="Close">${ICONS.close}</button>
        </div>
    </div>
    <button class="icon-button viewer-nav prev" type="button" id="viewer-prev" aria-label="Previous photo">${ICONS.prev}</button>
    <button class="icon-button viewer-nav next" type="button" id="viewer-next" aria-label="Next photo">${ICONS.next}</button>
</div>
<script type="module" src="/static/app.js"></script>`,
    });
}

const TABS = [['suggestions', 'Suggestions'], ['crop', 'Crop'], ['tools', 'Tools'], ['adjust', 'Adjust'], ['filters', 'Filters'], ['advanced', 'Advanced']];

export function editorPage({ assetId }) {
    return '<!doctype html>' + toString(html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Edit photo</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/edit/editor.css">
</head>
<body class="editor-body">
<div class="editor" id="editor" data-asset="${assetId}">
    <header class="editor-top">
        <button class="icon-button" type="button" id="ed-close" aria-label="Close">${ICONS.close}</button>
        <div class="editor-top-actions">
            <button class="text-button" type="button" id="ed-versions" hidden>Versions</button>
            <button class="button" type="button" id="ed-save" disabled>Save</button>
        </div>
    </header>
    <main class="editor-stage" id="ed-stage">
        <canvas id="ed-canvas" aria-label="Photo preview"></canvas>
        <p class="editor-status" id="ed-status">Loading photo…</p>
    </main>
    <div class="editor-ruler-bar" id="ed-ruler-bar" hidden>
        <button class="icon-button" type="button" id="ed-rotate90" aria-label="Rotate 90°">${ICONS.rotate}</button>
        <div class="ruler" id="ed-ruler" role="slider" tabindex="0" aria-label="Rotation angle" aria-valuemin="-45" aria-valuemax="45" aria-valuenow="0">
            <canvas id="ed-ruler-canvas" aria-hidden="true"></canvas>
            <output class="ruler-value" id="ed-angle" title="Double-click to type an exact angle">0°</output>
            <input class="ruler-input" id="ed-angle-input" type="number" step="0.1" min="-45" max="45" hidden aria-label="Exact rotation angle">
        </div>
        <button class="pill-button" type="button" id="ed-crop-reset">Reset</button>
    </div>
    <aside class="editor-panel">
        <div class="editor-tabs" role="tablist" aria-label="Editing tools">
            ${TABS.map(([id, label]) => html`<button type="button" role="tab" id="tab-${id}" data-tab="${id}" aria-controls="panel-${id}" aria-selected="false">${ICONS[`tab_${id}`]}<span>${label}</span></button>`)}
        </div>
        ${TABS.map(([id]) => html`<section class="editor-section" role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}" hidden></section>`)}
    </aside>
</div>
<dialog class="editor-dialog" id="ed-discard-dialog" aria-labelledby="ed-discard-title">
    <h2 id="ed-discard-title">Discard changes?</h2>
    <p>Your changes won't be saved</p>
    <div class="dialog-actions">
        <button class="text-button" type="button" id="ed-keep">Keep editing</button>
        <button class="text-button" type="button" id="ed-discard">Discard</button>
    </div>
</dialog>
<dialog class="editor-dialog versions-dialog" id="ed-versions-dialog" aria-labelledby="ed-versions-title">
    <h2 id="ed-versions-title">Versions</h2>
    <ul class="versions-list" id="ed-versions-list"></ul>
    <div class="dialog-actions">
        <button class="text-button danger" type="button" id="ed-discard-all">Discard all edits</button>
        <button class="text-button" type="button" id="ed-versions-close">Close</button>
    </div>
</dialog>
<div class="editor-saving" id="ed-saving" hidden><div class="spinner" aria-hidden="true"></div><p id="ed-saving-text">Saving…</p></div>
<script type="module" src="/static/edit/editor.js"></script>
</body>
</html>`);
}

export function messagePage({ title, message, action }) {
    return layout({
        title,
        bodyClass: 'message-body',
        body: html`<main class="message">
    <span class="message-logo">${ICONS.logo}</span>
    <h1>${title}</h1>
    <p>${message}</p>
    ${action ? html`<a class="button" href="${action.href}">${action.label}</a>` : ''}
</main>`,
    });
}
