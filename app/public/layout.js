// Pure layout and date helpers, shared by the browser and the tests

// Justified rows like Immich's grid: fill each row to `width` at about `targetHeight`;
// the last, incomplete row keeps the target height instead of being stretched
export function justify(ratios, width, targetHeight, gap = 4) {
    const rows = [];
    const available = Math.max(1, Math.floor(width));
    let pending = [];
    let ratioSum = 0;

    const emit = (fill) => {
        const gaps = gap * (pending.length - 1);
        const height = fill ? (available - gaps) / ratioSum : targetHeight;
        let used = 0;
        const items = pending.map(({ index, ratio }, i) => {
            const isLast = i === pending.length - 1;
            const itemWidth = fill && isLast ? available - gaps - used : Math.max(1, Math.round(ratio * height));
            used += itemWidth;
            return { index, width: itemWidth, height: Math.round(height) };
        });
        rows.push({ height: Math.round(height), items, filled: fill });
        pending = [];
        ratioSum = 0;
    };

    ratios.forEach((value, index) => {
        const ratio = Number(value) > 0 ? Number(value) : 1;
        pending.push({ index, ratio });
        ratioSum += ratio;
        if (ratioSum * targetHeight + gap * (pending.length - 1) >= available) emit(true);
    });
    if (pending.length) emit(false);
    return rows;
}

// Immich sends `timestamp without time zone` values without a zone suffix: they are UTC
export function parseUtc(value) {
    if (!value) return null;
    const text = String(value);
    const date = new Date(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
}

// A Date whose UTC fields are the wall-clock time where the photo was taken
export function localTime(fileCreatedAt, offsetHours = 0) {
    const date = parseUtc(fileCreatedAt);
    return date ? new Date(date.getTime() + (Number(offsetHours) || 0) * 3600 * 1000) : null;
}

// Consecutive assets of the same local day form one group, in Immich's order
export function groupByDay(bucket) {
    const groups = [];
    bucket.id.forEach((_, index) => {
        const time = localTime(bucket.fileCreatedAt[index], bucket.localOffsetHours[index]);
        const key = time ? time.toISOString().slice(0, 10) : 'unknown';
        const last = groups.at(-1);
        if (last && last.key === key) last.indices.push(index);
        else groups.push({ key, date: time, indices: [index] });
    });
    return groups;
}

export function formatDay(date, { now = new Date(), locale } = {}) {
    if (!date) return 'Unknown date';
    const options = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' };
    if (date.getUTCFullYear() !== now.getFullYear()) options.year = 'numeric';
    return new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatDateTime(date, { locale } = {}) {
    if (!date) return '';
    return new Intl.DateTimeFormat(locale, {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
    }).format(date);
}

// Durations arrive as milliseconds or as "H:MM:SS.mmm", depending on the Immich version
export function formatDuration(value) {
    let seconds = null;
    if (typeof value === 'number' && Number.isFinite(value)) seconds = value / 1000;
    else if (typeof value === 'string') {
        const match = value.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
        if (match) seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
    if (seconds === null || seconds <= 0) return '';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Rough height of a month that has not been loaded yet, so the scrollbar is about right
export function estimateMonthHeight(count, width, targetHeight, gap, headerHeight) {
    const perRow = Math.max(1, Math.round(Math.max(1, width) / (targetHeight * 1.35)));
    const rows = Math.ceil(count / perRow);
    const days = Math.max(1, Math.ceil(rows / 2));
    return rows * (targetHeight + gap) + days * headerHeight;
}
