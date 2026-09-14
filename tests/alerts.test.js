// tests/alerts.test.js — what the reception console announces, and when.
// Pure: no emulator, no browser, no speaker.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertTracker, SOON_MINUTES } from '../js/lib/alerts.js';

const NOW  = Date.parse('2026-09-11T08:00:00Z');
const at   = minutes => NOW + minutes * 60_000;
const hold = minutes => new Date(at(minutes));

const web = (id, over = {}) => ({
  id, status: 'pending', source: 'web', guestName: `Guest ${id}`, roomNumber: 2,
  checkIn: '2026-09-12', checkOut: '2026-09-13', holdExpiresAt: hold(120), ...over,
});

const ids = list => list.map(b => b.id);

describe('arrivals', () => {
  test('what is already waiting when the console opens is not announced', () => {
    const t = createAlertTracker();
    const r = t.update([web('a'), web('b')], NOW);
    assert.deepEqual(r.arrivals, []);
    assert.deepEqual(t.waiting, []);
  });

  test('a web booking that turns up afterwards is announced, once', () => {
    const t = createAlertTracker();
    t.update([web('a')], NOW);
    assert.deepEqual(ids(t.update([web('a'), web('b')], at(1)).arrivals), ['b']);
    assert.deepEqual(t.update([web('a'), web('b')], at(2)).arrivals, [], 'not announced a second time');
  });

  test('an arrival into an empty console is still an arrival', () => {
    const t = createAlertTracker();
    t.update([], NOW);                                   // console opened, nothing waiting
    assert.deepEqual(ids(t.update([web('a')], at(1)).arrivals), ['a']);
  });

  test('several arriving together are all announced and all wait', () => {
    const t = createAlertTracker();
    t.update([], NOW);
    const r = t.update([web('a'), web('b')], at(1));
    assert.deepEqual(ids(r.arrivals), ['a', 'b']);
    assert.deepEqual(ids(r.waiting), ['a', 'b']);
  });

  test('walk-ins and bookings that are not pending never ring', () => {
    const t = createAlertTracker();
    t.update([], NOW);
    const r = t.update([
      web('walk', { source: 'walkin', status: 'confirmed', holdExpiresAt: null }),
      web('conf', { status: 'confirmed', holdExpiresAt: null }),
      web('staff-pending', { source: 'walkin' }),
    ], at(1));
    assert.deepEqual(r.arrivals, []);
  });
});

describe('what stays waiting — and so keeps ringing', () => {
  test('it keeps waiting across later updates until someone deals with it', () => {
    const t = createAlertTracker();
    t.update([], NOW);
    t.update([web('a')], at(1));
    assert.deepEqual(ids(t.update([web('a')], at(5)).waiting), ['a']);
    assert.deepEqual(ids(t.update([web('a')], at(30)).waiting), ['a']);
  });

  test('"Got it" silences it without touching the booking', () => {
    const t = createAlertTracker();
    t.update([], NOW);
    t.update([web('a'), web('b')], at(1));
    assert.deepEqual(ids(t.acknowledge('a')), ['b'], 'one at a time');
    assert.deepEqual(t.acknowledge(), [], 'or all at once');
    assert.equal(t.isWaiting('b'), false);
    assert.deepEqual(t.update([web('a'), web('b')], at(2)).arrivals, [], 'and they do not come back');
  });

  test('confirming, declining or expiring it counts as dealing with it', () => {
    for (const status of ['confirmed', 'cancelled', 'expired', 'checked_in']) {
      const t = createAlertTracker();
      t.update([], NOW);
      t.update([web('a')], at(1));
      assert.deepEqual(t.update([web('a', { status })], at(2)).waiting, [], status);
    }
  });

  test('a booking that leaves the list altogether stops waiting', () => {
    const t = createAlertTracker();
    t.update([], NOW);
    t.update([web('a')], at(1));
    assert.deepEqual(t.update([], at(2)).waiting, []);
  });

  test('a hold that lapses stops ringing, even if nobody pressed anything', () => {
    const t = createAlertTracker();
    t.update([], NOW);
    t.update([web('a', { holdExpiresAt: hold(30) })], at(1));
    assert.equal(t.isWaiting('a'), true);
    assert.deepEqual(t.update([web('a', { holdExpiresAt: hold(30) })], at(31)).waiting, []);
  });

  test('a booking that arrives already lapsed is not announced', () => {
    const t = createAlertTracker();
    t.update([], NOW);
    assert.deepEqual(t.update([web('late', { holdExpiresAt: hold(-1) })], NOW).arrivals, []);
  });
});

describe('holds about to lapse', () => {
  test(`raised when ${SOON_MINUTES} minutes or less remain — even after "Got it"`, () => {
    const t = createAlertTracker();
    t.update([], NOW);
    const b = web('a', { holdExpiresAt: hold(60) });
    t.update([b], at(1));
    t.acknowledge('a');

    assert.deepEqual(t.update([b], at(40)).lapsingSoon, [], '20 minutes left: not yet');
    assert.deepEqual(ids(t.update([b], at(46)).lapsingSoon), ['a'], '14 minutes left: warn');
  });

  test('once heard, it is not raised again', () => {
    const t = createAlertTracker();
    const b = web('a', { holdExpiresAt: hold(10) });
    assert.deepEqual(ids(t.update([b], NOW).lapsingSoon), ['a']);
    t.markHeard([b]);
    assert.deepEqual(t.update([b], at(1)).lapsingSoon, []);
    assert.deepEqual(t.update([b], at(5)).lapsingSoon, [], 'not every half minute');
  });

  test('a warning nobody could hear — sound blocked — is kept until it is heard', () => {
    // The bug this guards: warned-once tracking spent the warning on the first
    // update after the console opened, when no click had unlocked sound yet.
    const t = createAlertTracker();
    const b = web('a', { holdExpiresAt: hold(10) });
    assert.deepEqual(ids(t.update([b], NOW).lapsingSoon), ['a'], 'raised; the bell was blocked');
    assert.deepEqual(ids(t.update([b], at(2)).lapsingSoon), ['a'], 'still owed');
    t.markHeard(['a']);                                   // ids work as well as bookings
    assert.deepEqual(t.update([b], at(3)).lapsingSoon, []);
  });

  test('an owed warning is dropped once the booking is dealt with, or lapses', () => {
    const t = createAlertTracker();
    t.update([web('a', { holdExpiresAt: hold(10) })], NOW);
    assert.deepEqual(t.update([web('a', { status: 'confirmed', holdExpiresAt: null })], at(1)).lapsingSoon, [],
      'confirmed in the meantime: nothing to warn about');

    const c = web('c', { holdExpiresAt: hold(10) });
    t.update([c], at(1));
    assert.deepEqual(t.update([c], at(12)).lapsingSoon, [], 'lapsed: too late to warn');
  });

  test('a hold already close to lapsing when the console opens is still warned about', () => {
    const t = createAlertTracker();
    const r = t.update([web('a', { holdExpiresAt: hold(5) })], NOW);
    assert.deepEqual(r.arrivals, [], 'not new — reception can see it');
    assert.deepEqual(ids(r.lapsingSoon), ['a'], 'but five minutes from gone deserves a nudge');
  });

  test('an arrival that is already inside the window is both an arrival and a warning', () => {
    const t = createAlertTracker();
    t.update([], NOW);
    const r = t.update([web('a', { holdExpiresAt: hold(10) })], NOW);
    assert.deepEqual(ids(r.arrivals), ['a']);
    assert.deepEqual(ids(r.lapsingSoon), ['a']);
  });

  test('a hold that has already lapsed is not "lapsing soon"', () => {
    const t = createAlertTracker();
    assert.deepEqual(t.update([web('a', { holdExpiresAt: hold(-2) })], NOW).lapsingSoon, []);
  });

  test('a confirmed booking never warns, whatever its old hold said', () => {
    const t = createAlertTracker();
    assert.deepEqual(t.update([web('a', { status: 'confirmed', holdExpiresAt: hold(3) })], NOW).lapsingSoon, []);
  });
});

describe('somebody says they have paid', () => {
  // A claim is money already sent, with a guest waiting to hear back, so it is
  // raised whether or not the booking itself was ever announced as new.
  const claim = (over = {}) => ({ status: 'claimed', reference: 'QWE4RT56YU', amount: 60000, ...over });
  const paid  = (id, payment = claim(), over = {}) => web(id, { payment, ...over });

  test('raised even when the booking was already sitting there', () => {
    const t = createAlertTracker();
    t.update([web('a')], NOW);                       // known, not new
    assert.deepEqual(t.update([web('a')], at(1)).arrivals, []);
    assert.deepEqual(ids(t.update([paid('a')], at(2)).paymentClaims), ['a']);
  });

  test('owed until the bell actually rang', () => {
    const t = createAlertTracker();
    assert.deepEqual(ids(t.update([paid('a')], NOW).paymentClaims), ['a']);
    assert.deepEqual(ids(t.update([paid('a')], at(1)).paymentClaims), ['a'], 'sound was blocked: still owed');
    t.markPaymentHeard(['a']);
    assert.deepEqual(t.update([paid('a')], at(2)).paymentClaims, [], 'heard once, not every half minute');
  });

  test('once the desk has answered it, it stops', () => {
    const t = createAlertTracker();
    t.update([paid('a')], NOW);
    assert.deepEqual(t.update([paid('a', claim({ status: 'received' }))], at(1)).paymentClaims, []);
    assert.deepEqual(t.update([paid('b', claim({ status: 'not_found' }))], at(2)).paymentClaims, []);
  });

  test('an ordinary booking raises nothing about money', () => {
    const t = createAlertTracker();
    assert.deepEqual(t.update([web('a')], NOW).paymentClaims, []);
  });

  test('a claim on a hold that has already lapsed is not raised', () => {
    const t = createAlertTracker();
    assert.deepEqual(t.update([paid('a', claim(), { holdExpiresAt: hold(-1) })], NOW).paymentClaims, []);
  });
});

describe('the baseline', () => {
  test('a list served from the local cache cannot set what counts as already waiting', () => {
    // Sign out and back in on the same page: Firestore first replays its stale
    // cached list, then the server's. A booking made in between must not ring.
    const t = createAlertTracker();
    const stale = [web('a')];
    const fresh = [web('a'), web('booked-while-signed-out')];
    assert.deepEqual(t.update(stale, NOW, { fromCache: true }).arrivals, []);
    assert.deepEqual(t.update(fresh, at(1)).arrivals, [], 'already waiting at the first real look');
    assert.deepEqual(t.waiting, []);
  });

  test('a genuine arrival after the server has been heard still rings', () => {
    const t = createAlertTracker();
    t.update([web('a')], NOW, { fromCache: true });
    t.update([web('a')], at(1));
    assert.deepEqual(ids(t.update([web('a'), web('new')], at(2)).arrivals), ['new']);
  });

  test('once primed, a cached list is handled normally, so the console does not go deaf offline', () => {
    const t = createAlertTracker();
    t.update([], NOW);
    assert.deepEqual(ids(t.update([web('local')], at(1), { fromCache: true }).arrivals), ['local']);
  });

  test('a console that has only ever seen the cache announces nothing and warns about nothing', () => {
    const t = createAlertTracker();
    const r = t.update([web('a', { holdExpiresAt: hold(5) })], NOW, { fromCache: true });
    assert.deepEqual(r, { arrivals: [], lapsingSoon: [], paymentClaims: [], waiting: [] });
  });
});

describe('inputs', () => {
  test('reads Firestore Timestamps as well as Dates', () => {
    const t = createAlertTracker();
    const asTimestamp = { toMillis: () => at(4) };
    assert.deepEqual(ids(t.update([web('a', { holdExpiresAt: asTimestamp })], NOW).lapsingSoon), ['a']);
  });

  test('the latest copy of a waiting booking is the one shown', () => {
    const t = createAlertTracker();
    t.update([], NOW);
    t.update([web('a', { roomNumber: 2 })], at(1));
    t.update([web('a', { roomNumber: 5 })], at(2));        // reception moved it
    assert.equal(t.waiting[0].roomNumber, 5);
  });
});
