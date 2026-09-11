// tests/reports.test.js — occupancy and revenue from the night ledger. Pure.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, monthSpan } from '../js/lib/reports.js';

const NOW = Date.parse('2026-09-15T08:00:00Z');

const rooms = [
  { id: 'room-1', number: 1, type: 'deluxe',   rate: 30000, active: true },
  { id: 'room-2', number: 2, type: 'standard', rate: 20000, active: true },
];

const sold = (roomId, date, rate) =>
  ({ roomId, date, bookingId: 'b', status: 'confirmed', holdExpiresAt: null, rate });
const held = (roomId, date, minutesLeft) =>
  ({ roomId, date, bookingId: 'h', status: 'held', holdExpiresAt: new Date(NOW + minutesLeft * 60_000) });

const span = { from: '2026-09-01', to: '2026-09-10' };   // 10 nights, 2 rooms: 20 to sell

describe('monthSpan', () => {
  test('knows how long each month is, leap years included', () => {
    assert.deepEqual(monthSpan('2026-09'), { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(monthSpan('2026-10'), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(monthSpan('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
    assert.deepEqual(monthSpan('2027-02'), { from: '2027-02-01', to: '2027-02-28' });
  });
  test('refuses anything that is not a month', () => {
    for (const bad of ['2026-9', '2026-13', 'September', '']) {
      assert.throws(() => monthSpan(bad), /YYYY-MM/, bad);
    }
  });
});

describe('what counts as sold', () => {
  test('a confirmed night earns the rate stamped on it, not today’s price', () => {
    const r = summarize({ rooms, cells: [sold('room-1', '2026-09-02', 25000)], ...span, nowMs: NOW });
    assert.equal(r.revenue, 25000, 'room-1 costs 30,000 today, but this night was agreed at 25,000');
  });

  test('occupancy, average rate and revenue per available night', () => {
    const cells = [
      sold('room-1', '2026-09-01', 30000), sold('room-1', '2026-09-02', 30000),
      sold('room-2', '2026-09-01', 20000), sold('room-2', '2026-09-02', 20000), sold('room-2', '2026-09-03', 20000),
    ];
    const r = summarize({ rooms, cells, ...span, nowMs: NOW });
    assert.equal(r.capacity, 20);
    assert.equal(r.sold, 5);
    assert.equal(r.occupancy, 0.25);
    assert.equal(r.revenue, 120000);
    assert.equal(r.averageRate, 24000);
    assert.equal(r.revenuePerAvailableNight, 6000);
  });

  test('a live hold is shown as held and earns nothing; a lapsed one is ignored', () => {
    const cells = [held('room-1', '2026-09-05', 60), held('room-2', '2026-09-05', -5)];
    const r = summarize({ rooms, cells, ...span, nowMs: NOW });
    assert.equal(r.held, 1);
    assert.equal(r.sold, 0);
    assert.equal(r.revenue, 0);
  });

  test('nights outside the span are left out', () => {
    const cells = [sold('room-1', '2026-08-31', 30000), sold('room-1', '2026-09-11', 30000)];
    const r = summarize({ rooms, cells, ...span, nowMs: NOW });
    assert.equal(r.sold, 0);
    assert.equal(r.revenue, 0);
  });

  test('a confirmed night with no rate on it is counted, earns nothing, and is flagged', () => {
    const cells = [{ roomId: 'room-1', date: '2026-09-03', status: 'confirmed', holdExpiresAt: null }];
    const r = summarize({ rooms, cells, ...span, nowMs: NOW });
    assert.equal(r.sold, 1);
    assert.equal(r.revenue, 0);
    assert.equal(r.unpriced, 1, 'shown, never guessed from the current price');
  });
});

describe('breakdowns', () => {
  test('per day and per room add up to the totals', () => {
    const cells = [
      sold('room-1', '2026-09-01', 30000), sold('room-2', '2026-09-01', 20000),
      sold('room-1', '2026-09-04', 30000), held('room-2', '2026-09-04', 30),
    ];
    const r = summarize({ rooms, cells, ...span, nowMs: NOW });

    assert.equal(r.byDay.length, 10);
    assert.deepEqual(r.byDay[0], { date: '2026-09-01', sold: 2, held: 0, revenue: 50000 });
    assert.deepEqual(r.byDay[3], { date: '2026-09-04', sold: 1, held: 1, revenue: 30000 });
    assert.equal(r.byDay.reduce((n, d) => n + d.revenue, 0), r.revenue);

    const room1 = r.byRoom.find(x => x.roomId === 'room-1');
    assert.equal(room1.sold, 2);
    assert.equal(room1.revenue, 60000);
    assert.equal(room1.occupancy, 0.2);
    assert.equal(r.byRoom.reduce((n, x) => n + x.sold, 0), r.sold);
  });

  test('a night in a room no longer listed still counts towards the totals', () => {
    const r = summarize({ rooms, cells: [sold('room-9', '2026-09-02', 40000)], ...span, nowMs: NOW });
    assert.equal(r.sold, 1);
    assert.equal(r.revenue, 40000);
  });

  test('an empty month is all zeros, with no division by zero', () => {
    const r = summarize({ rooms, cells: [], from: '2026-09-01', to: '2026-09-30', nowMs: NOW });
    assert.equal(r.capacity, 60);
    for (const key of ['sold', 'held', 'revenue', 'occupancy', 'averageRate', 'revenuePerAvailableNight']) {
      assert.equal(r[key], 0, key);
    }
    assert.ok(r.byRoom.every(x => x.occupancy === 0));
  });

  test('no rooms at all does not divide by zero either', () => {
    const r = summarize({ rooms: [], cells: [], ...span, nowMs: NOW });
    assert.equal(r.capacity, 0);
    assert.equal(r.occupancy, 0);
  });
});
