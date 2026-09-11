// js/lib/alerts.js
//
// Decides what the reception console should raise its voice about. Pure: it is
// handed the live list of bookings and the time, and says what is new — so the
// rules can be tested without a browser, a speaker or a database.
//
// The rules:
//   - Whatever is already waiting when the console opens is not announced as
//     new. Reception is looking straight at it.
//   - A web booking that turns up pending after that is an arrival. It stays
//     waiting, and keeps ringing, until someone presses "Got it", acts on it
//     (confirms or declines), or its hold lapses.
//   - A pending hold about to lapse is warned about — even if its arrival was
//     acknowledged, because acknowledging is not confirming — and the warning
//     is repeated until the console reports it was actually HEARD. A warning
//     raised while the browser was blocking sound must not be used up silently.

export const SOON_MINUTES = 15;

function millis(ts) {
  if (ts == null) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  const n = new Date(ts).getTime();
  return Number.isNaN(n) ? null : n;
}

export function createAlertTracker({ soonMinutes = SOON_MINUTES } = {}) {
  let primed = false;
  const seen    = new Set();   // pending web bookings already known about
  const waiting = new Map();   // id -> booking: announced, not yet dealt with
  const heard   = new Set();   // ids whose lapsing warning has actually played

  function update(bookings, nowMs = Date.now(), { fromCache = false } = {}) {
    // The baseline — "what was already waiting" — must come from the server.
    // After signing out and back in on the same page, Firestore first replays
    // its cached copy from the earlier session; a baseline taken from that makes
    // everything booked in the meantime look new. Measured 2026-09-11: first
    // snapshot fromCache with 14 bookings, then the server's with 15. Until the
    // server has been heard, a cached list is ignored entirely.
    if (!primed && fromCache) return { arrivals: [], lapsingSoon: [], waiting: [] };

    // Only live web requests matter. A lapsed hold has nothing left to say: the
    // room is already back on sale, and "Clear lapsed" tidies the row.
    const live = new Map();
    for (const b of bookings) {
      if (b.status !== 'pending' || b.source !== 'web') continue;
      const expiry = millis(b.holdExpiresAt);
      if (expiry !== null && expiry <= nowMs) continue;
      live.set(b.id, b);
    }

    const arrivals = [];
    for (const [id, b] of live) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (primed) {
        waiting.set(id, b);
        arrivals.push(b);
      }
    }
    primed = true;

    // Dealing with a booking, or its hold lapsing, acknowledges it.
    for (const id of [...waiting.keys()]) {
      if (live.has(id)) waiting.set(id, live.get(id));
      else waiting.delete(id);
    }

    // Returned on every update until markHeard() — so a warning that could not
    // be played is still owed, and one about a booking since dealt with is not.
    const lapsingSoon = [];
    for (const [id, b] of live) {
      const expiry = millis(b.holdExpiresAt);
      if (expiry === null || heard.has(id)) continue;
      if (expiry - nowMs <= soonMinutes * 60_000) lapsingSoon.push(b);
    }

    return { arrivals, lapsingSoon, waiting: [...waiting.values()] };
  }

  /** "Got it". With an id, just that booking; without, everything waiting. */
  function acknowledge(id) {
    if (id === undefined) waiting.clear();
    else waiting.delete(id);
    return [...waiting.values()];
  }

  /** The console calls this only after the lapsing warning really played. */
  function markHeard(bookingsOrIds) {
    for (const b of bookingsOrIds) heard.add(typeof b === 'string' ? b : b.id);
  }

  return {
    update,
    acknowledge,
    markHeard,
    get waiting() { return [...waiting.values()]; },
    isWaiting: id => waiting.has(id),
  };
}
