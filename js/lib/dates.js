// js/lib/dates.js
//
// Dates are plain 'YYYY-MM-DD' strings everywhere in this system — never Date
// objects. Tanzania is UTC+3, and a Date round-trip through the browser's local
// zone can silently shift a booking by a day. ISO strings sort and compare
// correctly with < and >, so we lose nothing by keeping them as text.

export const MAX_NIGHTS = 30;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(s) {
  return typeof s === 'string' && DATE_RE.test(s);
}

function assertDate(s, label) {
  if (!isDateStr(s)) throw new Error(`${label} must be YYYY-MM-DD, got ${JSON.stringify(s)}`);
}

/** Today on the *local* calendar. toISOString() would give the UTC day, which
 *  is the previous day here for the first three hours of every morning. */
export function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Calendar arithmetic done in UTC so no offset or DST rule can interfere. */
export function addDays(dateStr, n) {
  assertDate(dateStr, 'date');
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** The nights actually slept. Check-out day is NOT a night: arriving on the
 *  20th and leaving on the 22nd is two nights, the 20th and the 21st. This
 *  off-by-one is the single easiest way to double-book a room. */
export function nightsBetween(checkIn, checkOut) {
  assertDate(checkIn, 'checkIn');
  assertDate(checkOut, 'checkOut');
  if (checkOut <= checkIn) throw new Error('checkOut must be after checkIn');

  const nights = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    nights.push(d);
    if (nights.length > MAX_NIGHTS) throw new Error(`stay exceeds ${MAX_NIGHTS} nights`);
  }
  return nights;
}

export function countNights(checkIn, checkOut) {
  return nightsBetween(checkIn, checkOut).length;
}

/** Document id for the allocation ledger. */
export function nightKey(roomId, date) {
  assertDate(date, 'date');
  return `${roomId}_${date}`;
}

/** Every night key a stay would claim, in order. */
export function nightKeys(roomId, checkIn, checkOut) {
  return nightsBetween(checkIn, checkOut).map(d => nightKey(roomId, d));
}

/** Inclusive span, for calendar views. */
export function dateRange(from, to) {
  assertDate(from, 'from');
  assertDate(to, 'to');
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function fmtDate(dateStr) {
  assertDate(dateStr, 'date');
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
  });
}
