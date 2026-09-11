import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDateStr, addDays, nightsBetween, countNights,
  nightKey, nightKeys, dateRange, today, MAX_NIGHTS
} from '../js/lib/dates.js';

test('checkout day is not a night', () => {
  assert.deepEqual(nightsBetween('2026-09-20', '2026-09-22'), ['2026-09-20', '2026-09-21']);
  assert.equal(countNights('2026-09-20', '2026-09-22'), 2);
});

test('a one-night stay is one night', () => {
  assert.deepEqual(nightsBetween('2026-09-20', '2026-09-21'), ['2026-09-20']);
});

test('crosses month boundaries', () => {
  assert.deepEqual(nightsBetween('2026-09-29', '2026-10-02'),
    ['2026-09-29', '2026-09-30', '2026-10-01']);
});

test('crosses year boundaries', () => {
  assert.deepEqual(nightsBetween('2026-12-31', '2027-01-02'),
    ['2026-12-31', '2027-01-01']);
});

test('handles leap day', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
});

test('addDays goes backwards too', () => {
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('rejects a zero or negative stay', () => {
  assert.throws(() => nightsBetween('2026-09-20', '2026-09-20'), /after checkIn/);
  assert.throws(() => nightsBetween('2026-09-22', '2026-09-20'), /after checkIn/);
});

test('rejects malformed dates rather than guessing', () => {
  assert.throws(() => nightsBetween('20-09-2026', '2026-09-22'), /YYYY-MM-DD/);
  assert.throws(() => addDays('not-a-date', 1), /YYYY-MM-DD/);
  assert.equal(isDateStr('2026-9-1'), false);
});

test('refuses a stay longer than the cap', () => {
  assert.throws(() => nightsBetween('2026-01-01', '2026-06-01'), /exceeds 30 nights/);
  // exactly at the cap is fine
  assert.equal(countNights('2026-01-01', '2026-01-31'), MAX_NIGHTS);
});

test('night keys match the id the rules expect', () => {
  assert.equal(nightKey('room-4', '2026-09-20'), 'room-4_2026-09-20');
  assert.deepEqual(nightKeys('room-4', '2026-09-20', '2026-09-22'),
    ['room-4_2026-09-20', 'room-4_2026-09-21']);
});

test('dateRange is inclusive at both ends', () => {
  assert.deepEqual(dateRange('2026-09-20', '2026-09-22'),
    ['2026-09-20', '2026-09-21', '2026-09-22']);
});

test('today() is the local calendar day, not the UTC one', () => {
  // The bug this guards: at 01:00 EAT, toISOString() still reports yesterday.
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  assert.equal(today(), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  assert.ok(isDateStr(today()));
});
