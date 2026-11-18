import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateMonthHeight, formatDateTime, formatDay, formatDuration, groupByDay, justify, localTime, parseUtc } from '../public/layout.js';

const rowWidth = row => row.items.reduce((sum, item) => sum + item.width, 0);

test('full rows fill the width exactly, including gaps', () => {
    const ratios = [1.5, 0.667, 1, 1.778, 0.75, 1.333, 2.4, 0.5625, 1, 1.5, 1.5, 0.75];
    const rows = justify(ratios, 1000, 235, 4);
    const full = rows.filter(row => row.filled);
    assert.ok(full.length >= 2);
    for (const row of full) {
        assert.equal(rowWidth(row) + 4 * (row.items.length - 1), 1000);
        assert.ok(row.height <= 235 + 1, 'rows only shrink to fit');
    }
    assert.deepEqual(rows.flatMap(row => row.items.map(item => item.index)), ratios.map((_, i) => i), 'keeps order');
});

test('the last incomplete row keeps the target height', () => {
    const rows = justify([1, 1, 1, 1], 1000, 200, 4);
    const last = rows.at(-1);
    assert.equal(last.filled, false);
    assert.equal(last.height, 200);
    assert.ok(rowWidth(last) < 1000);
});

test('a single panorama fills its own row', () => {
    const [row] = justify([10], 1000, 235, 4);
    assert.equal(row.items[0].width, 1000);
    assert.equal(row.height, 100);
});

test('invalid ratios count as square', () => {
    const [row] = justify([0, -2, null], 1000, 100, 0);
    assert.deepEqual(row.items.map(item => item.width), [100, 100, 100]);
});

test('timestamps without a zone are read as UTC', () => {
    assert.equal(parseUtc('2026-11-18T10:00:00.000').toISOString(), '2026-11-18T10:00:00.000Z');
    assert.equal(parseUtc('2026-11-18T10:00:00+02:00').toISOString(), '2026-11-18T08:00:00.000Z');
    assert.equal(parseUtc(null), null);
    assert.equal(parseUtc('nonsense'), null);
});

test('days are grouped by local time at the place the photo was taken', () => {
    const groups = groupByDay({
        id: ['a', 'b', 'c', 'd'],
        fileCreatedAt: ['2026-11-17T23:30:00', '2026-11-17T22:00:00', '2026-11-17T12:00:00', '2026-11-16T08:00:00'],
        localOffsetHours: [2, 1, 2, 0],
    });
    assert.deepEqual(groups.map(g => [g.key, g.indices]), [
        ['2026-11-18', [0]],
        ['2026-11-17', [1, 2]],
        ['2026-11-16', [3]],
    ]);
    assert.equal(localTime('2026-11-17T23:30:00', 2).toISOString(), '2026-11-18T01:30:00.000Z');
});

test('day titles omit the current year', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    assert.equal(formatDay(new Date('2026-11-17T00:00:00Z'), { now, locale: 'en-US' }), 'Tue, Nov 17');
    assert.equal(formatDay(new Date('2025-11-17T00:00:00Z'), { now, locale: 'en-US' }), 'Mon, Nov 17, 2025');
    assert.equal(formatDay(null), 'Unknown date');
});

test('captions show the local wall-clock time', () => {
    assert.equal(formatDateTime(localTime('2026-11-17T23:30:00', 2), { locale: 'en-US' }), 'Wed, Nov 18, 2026, 1:30 AM');
});

test('durations accept milliseconds and Immich time strings', () => {
    assert.equal(formatDuration(4200), '0:04');
    assert.equal(formatDuration(65000), '1:05');
    assert.equal(formatDuration('0:01:05.123'), '1:05');
    assert.equal(formatDuration('1:02:03.000'), '1:02:03');
    assert.equal(formatDuration(null), '');
    assert.equal(formatDuration('0:00:00.000'), '');
});

test('month estimates grow with the asset count', () => {
    const small = estimateMonthHeight(10, 1200, 235, 4, 52);
    const large = estimateMonthHeight(100, 1200, 235, 4, 52);
    assert.ok(small > 0 && large > small * 5);
});
