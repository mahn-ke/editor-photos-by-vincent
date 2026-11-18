import { html, toString } from './html.js';

const ICONS = {
    logo: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5Zm2.5-.5a.5.5 0 0 0-.5.5v9.59l3.3-3.3a1 1 0 0 1 1.4 0l1.8 1.8 3.8-3.8a1 1 0 0 1 1.4 0L18 11.9V5.5a.5.5 0 0 0-.5-.5ZM9 9.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z"/></svg>`,
    close: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4Z"/></svg>`,
    prev: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 6.4 14 5l-7 7 7 7 1.4-1.4L9.8 12Z"/></svg>`,
    next: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.6 6.4 1.4-1.4 7 7-7 7-1.4-1.4 5.6-5.6Z"/></svg>`,
    play: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>`,
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
        <button class="icon-button" type="button" id="viewer-close" aria-label="Close">${ICONS.close}</button>
    </div>
    <button class="icon-button viewer-nav prev" type="button" id="viewer-prev" aria-label="Previous photo">${ICONS.prev}</button>
    <button class="icon-button viewer-nav next" type="button" id="viewer-next" aria-label="Next photo">${ICONS.next}</button>
</div>
<script type="module" src="/static/app.js"></script>`,
    });
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
