// tests/availability.test.js — the allocation engine, against the emulator.
// Start it first:  npm run emu
//
// These run with security rules ENABLED and real guest/staff contexts, so a
// pass here means the whole path works, not just the JavaScript.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, collection, getDocs, Timestamp } from 'firebase/firestore';
import { readFileSync } from 'node:fs';

import {
  createBooking, confirmBooking, cancelBooking, sweepExpiredHolds,
  checkInGuest, checkOutGuest, extendHold, MAX_EXTENSION_MINUTES,
  fetchAvailability, isRoomFree, freeRooms, loadRooms, cellBlocks, blockedFromCells,
  bookingReference, nextAllowance,
  RoomUnavailableError, HoldLimitError, MAX_WEB_HOLDS,
} from '../js/lib/availability.js';
import { addDays, today, nightsBetween, nightKey } from '../js/lib/dates.js';

let env;
const HOST = '127.0.0.1', PORT = 8081;

// Always book in the future — createBooking rejects past check-ins.
const D1 = addDays(today(), 10);
const D2 = addDays(today(), 11);
const D3 = addDays(today(), 12);
const D4 = addDays(today(), 13);

const guestA = () => env.authenticatedContext('guest-a').firestore();
const guestB = () => env.authenticatedContext('guest-b').firestore();
const staff  = () => env.authenticatedContext('rec-1', { role: 'reception' }).firestore();
const anon   = () => env.unauthenticatedContext().firestore();

const bookingInput = (over = {}) => ({
  roomId: 'room-4', checkIn: D1, checkOut: D3,
  guestName: 'Amina Hassan', guestPhone: '+255700000000',
  uid: 'guest-a', source: 'web', ...over,
});

async function seedRooms() {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'rooms/room-1'), { number: 1, type: 'deluxe',   rate: 30000, active: true });
    await setDoc(doc(db, 'rooms/room-2'), { number: 2, type: 'standard', rate: 20000, active: true });
    await setDoc(doc(db, 'rooms/room-4'), { number: 4, type: 'deluxe',   rate: 30000, active: true });
    await setDoc(doc(db, 'rooms/room-6'), { number: 6, type: 'deluxe',   rate: 30000, active: false });
  });
}

/**
 * A hold placed earlier that has since lapsed. Written past the rules on
 * purpose: a guest can never create one, because the rules require a future
 * expiry — that refusal is itself part of the protection, and is asserted in
 * tests/rules.test.js. Here we only need the aftermath.
 */
let lapsedSeq = 0;
async function seedLapsedBooking(over = {}) {
  const { roomId = 'room-4', checkIn = D1, checkOut = D3, uid = 'guest-old' } = over;
  const nights  = nightsBetween(checkIn, checkOut);
  const expired = Timestamp.fromMillis(Date.now() - 5 * 60_000);
  const id      = `lapsed-${++lapsedSeq}`;

  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, `bookings/${id}`), {
      roomId, roomNumber: 4,
      guestName: 'Earlier Guest', guestPhone: '+255700000009',
      checkIn, checkOut, nights: nights.length,
      ratePerNight: 30000, total: 30000 * nights.length,
      status: 'pending', source: 'web', createdBy: uid,
      holdExpiresAt: expired, createdAt: new Date(),
    });
    for (const d of nights) {
      await setDoc(doc(db, `nights/${nightKey(roomId, d)}`), {
        roomId, date: d, bookingId: id, status: 'held', holdExpiresAt: expired,
      });
    }
  });
  return { id, nights };
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-karibu-avail',
    firestore: { host: HOST, port: PORT, rules: readFileSync('firestore.rules', 'utf8') },
  });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await seedRooms(); });

/* ────────────────────────────────────────────────────────────── */

describe('claiming a room', () => {
  test('a booking claims exactly one cell per night slept', async () => {
    const b = await createBooking(guestA(), bookingInput());
    assert.equal(b.nights, 2);
    assert.equal(b.ratePerNight, 30000);
    assert.equal(b.total, 60000);
    assert.equal(b.status, 'pending');

    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      assert.ok((await getDoc(doc(db, `nights/room-4_${D1}`))).exists(), `${D1} claimed`);
      assert.ok((await getDoc(doc(db, `nights/room-4_${D2}`))).exists(), `${D2} claimed`);
      // The checkout day is not slept in and must stay free.
      assert.equal((await getDoc(doc(db, `nights/room-4_${D3}`))).exists(), false);
      const all = await getDocs(collection(db, 'nights'));
      assert.equal(all.size, 2);
    });
  });

  test('the rate is snapshotted, so a later price change does not rewrite it', async () => {
    const b = await createBooking(guestA(), bookingInput());
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), 'rooms/room-4'),
        { number: 4, type: 'deluxe', rate: 99000, active: true });
    });
    await env.withSecurityRulesDisabled(async ctx => {
      const after = await getDoc(doc(ctx.firestore(), `bookings/${b.id}`));
      assert.equal(after.data().ratePerNight, 30000);
      assert.equal(after.data().total, 60000);
    });
  });

  test('an inactive room cannot be booked', async () => {
    await assert.rejects(
      () => createBooking(guestA(), bookingInput({ roomId: 'room-6' })),
      /not bookable/);
  });

  test('a past check-in is refused', async () => {
    await assert.rejects(
      () => createBooking(guestA(), bookingInput({
        checkIn: addDays(today(), -1), checkOut: D1 })),
      /in the past/);
  });

  test('a nonexistent room is refused', async () => {
    await assert.rejects(
      () => createBooking(guestA(), bookingInput({ roomId: 'room-99' })),
      /unknown room/);
  });

  test('bad guest details are refused before anything is written', async () => {
    await assert.rejects(() => createBooking(guestA(), bookingInput({ guestName: 'A' })), /2-100/);
    await assert.rejects(() => createBooking(guestA(), bookingInput({ guestPhone: 'abc' })), /valid number/);
    await env.withSecurityRulesDisabled(async ctx => {
      assert.equal((await getDocs(collection(ctx.firestore(), 'nights'))).size, 0);
    });
  });
});

describe('overlap', () => {
  test('the same nights are refused, naming the clash', async () => {
    await createBooking(guestA(), bookingInput());
    await assert.rejects(
      () => createBooking(guestB(), bookingInput({ uid: 'guest-b' })),
      err => {
        assert.ok(err instanceof RoomUnavailableError);
        assert.deepEqual(err.takenDates, [D1, D2]);
        return true;
      });
  });

  test('a partial overlap is refused on just the clashing night', async () => {
    await createBooking(guestA(), bookingInput({ checkIn: D1, checkOut: D3 }));  // sleeps D1,D2
    await assert.rejects(
      () => createBooking(guestB(), bookingInput({ uid: 'guest-b', checkIn: D2, checkOut: D4 })),
      err => {
        assert.deepEqual(err.takenDates, [D2]);
        return true;
      });
  });

  test('back-to-back stays both succeed — checkout day is free', async () => {
    // This is the off-by-one that would otherwise lose a night of revenue.
    await createBooking(guestA(), bookingInput({ checkIn: D1, checkOut: D3 }));
    const second = await createBooking(guestB(), bookingInput({ uid: 'guest-b', checkIn: D3, checkOut: D4 }));
    assert.equal(second.nights, 1);
  });

  test('a different room on the same nights is unaffected', async () => {
    await createBooking(guestA(), bookingInput({ roomId: 'room-4' }));
    const other = await createBooking(guestB(), bookingInput({ uid: 'guest-b', roomId: 'room-1' }));
    assert.equal(other.roomId, 'room-1');
  });
});

describe('concurrency', () => {
  test('two simultaneous bookings for the same room: exactly one wins', async () => {
    const results = await Promise.allSettled([
      createBooking(guestA(), bookingInput({ uid: 'guest-a' })),
      createBooking(guestB(), bookingInput({ uid: 'guest-b' })),
    ]);

    const ok   = results.filter(r => r.status === 'fulfilled');
    const fail = results.filter(r => r.status === 'rejected');
    assert.equal(ok.length, 1, 'exactly one booking should succeed');
    assert.equal(fail.length, 1);
    assert.ok(fail[0].reason instanceof RoomUnavailableError,
      `loser should get RoomUnavailableError, got ${fail[0].reason}`);

    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      // One booking's worth of cells, and they all point at the winner.
      const cells = await getDocs(collection(db, 'nights'));
      assert.equal(cells.size, 2);
      cells.forEach(c => assert.equal(c.data().bookingId, ok[0].value.id));
    });
  });

  test('five simultaneous bookings for one room: still exactly one wins', async () => {
    const attempts = ['a', 'b', 'c', 'd', 'e'].map(k =>
      createBooking(env.authenticatedContext(`guest-${k}`).firestore(),
        bookingInput({ uid: `guest-${k}` })));

    const results = await Promise.allSettled(attempts);
    const ok = results.filter(r => r.status === 'fulfilled');
    assert.equal(ok.length, 1, `expected 1 winner, got ${ok.length}`);

    await env.withSecurityRulesDisabled(async ctx => {
      const cells = await getDocs(collection(ctx.firestore(), 'nights'));
      assert.equal(cells.size, 2, 'the ledger must hold one stay, not five');
    });
  });

  test('simultaneous bookings for different rooms all succeed', async () => {
    const results = await Promise.allSettled([
      createBooking(guestA(), bookingInput({ uid: 'guest-a', roomId: 'room-1' })),
      createBooking(guestB(), bookingInput({ uid: 'guest-b', roomId: 'room-2' })),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  });
});

describe('how much one visitor may hold', () => {
  // Holding is free and takes a room out of the window for two hours, so the
  // website limits it. The desk does not need limiting: a walk-in is a person
  // standing at the counter.
  const threeRooms = async (db, uid) => {
    await createBooking(db, bookingInput({ uid, roomId: 'room-1' }));
    await createBooking(db, bookingInput({ uid, roomId: 'room-2' }));
    await createBooking(db, bookingInput({ uid, roomId: 'room-4' }));
  };

  test(`${MAX_WEB_HOLDS} rooms is fine, and the next one is refused without a trace`, async () => {
    await threeRooms(guestA(), 'guest-a');

    await assert.rejects(
      // a room that is genuinely free, on nights nobody has claimed
      () => createBooking(guestA(), bookingInput({ roomId: 'room-1', checkIn: D3, checkOut: D4 })),
      HoldLimitError);

    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      assert.equal((await getDocs(collection(db, 'bookings'))).size, 3, 'the fourth was not written');
      assert.equal((await getDocs(collection(db, 'nights'))).size, 6, 'and it claimed no nights');
      assert.equal((await getDoc(doc(db, 'webHolds/guest-a'))).data().count, MAX_WEB_HOLDS);
    });
  });

  test('the limit is per visitor, not per lodge', async () => {
    await threeRooms(guestA(), 'guest-a');
    const b = await createBooking(guestB(), bookingInput({ uid: 'guest-b', roomId: 'room-1', checkIn: D3, checkOut: D4 }));
    assert.equal(b.status, 'pending');
  });

  test('the desk can take as many walk-ins as there are rooms', async () => {
    const walkIn = over => createBooking(staff(), bookingInput({
      uid: 'rec-1', source: 'walkin', status: 'confirmed', ...over }));
    await walkIn({ roomId: 'room-1' });
    await walkIn({ roomId: 'room-2' });
    await walkIn({ roomId: 'room-4' });
    const fourth = await walkIn({ roomId: 'room-1', checkIn: D3, checkOut: D4 });
    assert.equal(fourth.status, 'confirmed');
  });

  test('the count starts again once the two hours have passed', async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), 'webHolds/guest-a'),
        { count: MAX_WEB_HOLDS, windowStart: Timestamp.fromMillis(Date.now() - 3 * 3600_000) });
    });

    const b = await createBooking(guestA(), bookingInput());
    assert.equal(b.status, 'pending');
    await env.withSecurityRulesDisabled(async ctx => {
      assert.equal((await getDoc(doc(ctx.firestore(), 'webHolds/guest-a'))).data().count, 1);
    });
  });

  test('nextAllowance: counts up inside the window, starts again outside it', () => {
    const snap = data => ({ exists: () => data != null, data: () => data });
    const now = Date.now();
    const fresh = t => ({ toMillis: () => t });

    assert.equal(nextAllowance(snap(null), now).count, 1, 'the first hold ever');
    assert.equal(nextAllowance(snap({ count: 1, windowStart: fresh(now - 60_000) }), now).count, 2);
    assert.equal(nextAllowance(snap({ count: MAX_WEB_HOLDS, windowStart: fresh(now - 3 * 3600_000) }), now).count, 1,
      'the old window has run out');
    assert.throws(() => nextAllowance(snap({ count: MAX_WEB_HOLDS, windowStart: fresh(now - 60_000) }), now),
      HoldLimitError);
    // A counter nobody can make sense of must not be a way through.
    assert.equal(nextAllowance(snap({ count: 'lots', windowStart: fresh(now) }), now).count, 1);
  });
});

describe('holds and expiry', () => {
  test('a live hold blocks', async () => {
    await createBooking(guestA(), bookingInput());
    const blocked = await fetchAvailability(anon(), D1, D4);
    assert.equal(isRoomFree(blocked, 'room-4', D1, D3), false);
    assert.equal(isRoomFree(blocked, 'room-1', D1, D3), true);
  });

  test('a lapsed hold stops blocking with nothing having to run', async () => {
    await seedLapsedBooking();
    const blocked = await fetchAvailability(anon(), D1, D4);
    assert.equal(isRoomFree(blocked, 'room-4', D1, D3), true);
  });

  test('a lapsed hold can be reclaimed by the next guest', async () => {
    await seedLapsedBooking();
    const second = await createBooking(guestB(), bookingInput({ uid: 'guest-b' }));
    await env.withSecurityRulesDisabled(async ctx => {
      const cell = await getDoc(doc(ctx.firestore(), `nights/room-4_${D1}`));
      assert.equal(cell.data().bookingId, second.id);
    });
  });

  test('cellBlocks: confirmed cells never lapse', () => {
    const past = new Date(Date.now() - 60_000);
    assert.equal(cellBlocks({ status: 'held',      holdExpiresAt: past }), false);
    assert.equal(cellBlocks({ status: 'confirmed', holdExpiresAt: null }), true);
    assert.equal(cellBlocks({ status: 'held',      holdExpiresAt: null }), true);
    assert.equal(cellBlocks(null), false);
  });
});

describe('lifecycle', () => {
  test('confirming makes the hold permanent and stamps the agreed rate', async () => {
    const b = await createBooking(guestA(), bookingInput());
    await confirmBooking(staff(), b.id, 'rec-1');

    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      const booking = await getDoc(doc(db, `bookings/${b.id}`));
      assert.equal(booking.data().status, 'confirmed');
      assert.equal(booking.data().holdExpiresAt, null);

      const cell = await getDoc(doc(db, `nights/room-4_${D1}`));
      assert.equal(cell.data().status, 'confirmed');
      assert.equal(cell.data().holdExpiresAt, null);
      assert.equal(cell.data().rate, 30000, 'rate is stamped for revenue reporting');
    });
  });

  test('a confirmed stay blocks long after the original hold would have lapsed', async () => {
    const b = await createBooking(guestA(), bookingInput({ holdMinutes: 1 }));
    await confirmBooking(staff(), b.id, 'rec-1');
    const wayLater = Date.now() + 365 * 24 * 3600_000;
    const blocked = await fetchAvailability(anon(), D1, D4, wayLater);
    assert.equal(isRoomFree(blocked, 'room-4', D1, D3), false);
  });

  test('confirming twice is refused', async () => {
    const b = await createBooking(guestA(), bookingInput());
    await confirmBooking(staff(), b.id, 'rec-1');
    await assert.rejects(() => confirmBooking(staff(), b.id, 'rec-1'), /already confirmed/);
  });

  test('confirming a booking whose nights were reclaimed is refused', async () => {
    const a = await seedLapsedBooking();
    await createBooking(guestB(), bookingInput({ uid: 'guest-b' }));   // takes the nights
    await assert.rejects(() => confirmBooking(staff(), a.id, 'rec-1'), RoomUnavailableError);
  });

  test('cancelling releases the nights but keeps the record', async () => {
    const b = await createBooking(guestA(), bookingInput());
    await cancelBooking(staff(), b.id, 'guest changed plans', 'rec-1');

    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      const booking = await getDoc(doc(db, `bookings/${b.id}`));
      assert.equal(booking.exists(), true, 'the booking is never deleted');
      assert.equal(booking.data().status, 'cancelled');
      assert.equal(booking.data().cancelReason, 'guest changed plans');
      assert.equal((await getDocs(collection(db, 'nights'))).size, 0, 'nights handed back');
    });

    const next = await createBooking(guestB(), bookingInput({ uid: 'guest-b' }));
    assert.equal(next.status, 'pending');
  });

  test('cancelling does not steal back a night someone else reclaimed', async () => {
    const a = await seedLapsedBooking();
    const b = await createBooking(guestB(), bookingInput({ uid: 'guest-b' }));
    await cancelBooking(staff(), a.id, 'lapsed', 'rec-1');

    await env.withSecurityRulesDisabled(async ctx => {
      const cell = await getDoc(doc(ctx.firestore(), `nights/room-4_${D1}`));
      assert.equal(cell.exists(), true, "guest B's claim must survive");
      assert.equal(cell.data().bookingId, b.id);
    });
  });

  test('the sweep tidies lapsed holds and leaves live ones alone', async () => {
    const dead = await seedLapsedBooking();
    const live = await createBooking(guestB(), bookingInput({ uid: 'guest-b', roomId: 'room-1' }));

    const swept = await sweepExpiredHolds(staff(), 'rec-1');
    assert.deepEqual(swept, [dead.id]);

    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      assert.equal((await getDoc(doc(db, `bookings/${dead.id}`))).data().status, 'expired');
      assert.equal((await getDoc(doc(db, `bookings/${live.id}`))).data().status, 'pending');
      const cells = await getDocs(collection(db, 'nights'));
      assert.equal(cells.size, 2, 'only the live booking keeps its nights');
      cells.forEach(c => assert.equal(c.data().bookingId, live.id));
    });
  });
});

describe('the desk makes an exception to the two hours', () => {
  // Two hours is the rule for a web hold. Reception may hold a room longer for
  // a guest who has phoned to say they are on their way — nobody else can.
  const recordOf = async () => {
    let entries = [];
    await env.withSecurityRulesDisabled(async ctx => {
      const snap = await getDocs(collection(ctx.firestore(), 'audit'));
      entries = snap.docs.map(d => d.data());
    });
    return entries;
  };

  test('the booking and every night it holds move together', async () => {
    const b = await createBooking(guestA(), bookingInput({ holdMinutes: 5 }));
    const out = await extendHold(staff(), b.id, 180, 'rec-1');
    assert.ok(out.holdExpiresAt.getTime() > Date.now() + 170 * 60_000);

    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      const booking = await getDoc(doc(db, `bookings/${b.id}`));
      for (const d of [D1, D2]) {
        const cell = await getDoc(doc(db, `nights/room-4_${d}`));
        assert.equal(cell.data().holdExpiresAt.toMillis(), booking.data().holdExpiresAt.toMillis(),
          `${d}: the ledger and the booking must agree when the hold runs out`);
        assert.equal(cell.data().status, 'held');
        assert.equal(cell.data().bookingId, b.id);
      }
    });
  });

  test('the room really is still held after the original two hours would have lapsed', async () => {
    const b = await createBooking(guestA(), bookingInput({ holdMinutes: 5 }));
    await extendHold(staff(), b.id, 180, 'rec-1');

    const wellPastTheOriginal = Date.now() + 60 * 60_000;
    const blocked = await fetchAvailability(anon(), D1, D4, wellPastTheOriginal);
    assert.equal(isRoomFree(blocked, 'room-4', D1, D3), false);
    await assert.rejects(
      () => createBooking(guestB(), bookingInput({ uid: 'guest-b' })),
      RoomUnavailableError);
  });

  test('the exception is on the record, in the name of whoever granted it', async () => {
    const b = await createBooking(guestA(), bookingInput());
    await extendHold(staff(), b.id, 120, 'rec-1');

    const entry = (await recordOf()).find(e => e.action === 'extend_hold');
    assert.ok(entry, 'an extension must be recorded');
    assert.equal(entry.actor, 'rec-1');
    assert.equal(entry.bookingId, b.id);
    assert.match(entry.summary, /Amina Hassan · Room 4/);
    assert.match(entry.summary, /120 minutes longer/);
    assert.ok(entry.after.holdExpiresAt, 'the new expiry is recorded');
  });

  test('only a hold can be extended — a confirmed stay has no expiry to move', async () => {
    const b = await createBooking(guestA(), bookingInput());
    await confirmBooking(staff(), b.id, 'rec-1');
    await assert.rejects(() => extendHold(staff(), b.id, 120, 'rec-1'), /only a hold can be extended/);
  });

  test('a silly length is refused before anything moves', async () => {
    const b = await createBooking(guestA(), bookingInput());
    // withSecurityRulesDisabled resolves undefined, so read out through a
    // binding rather than its return value.
    let was;
    await env.withSecurityRulesDisabled(async ctx => {
      was = (await getDoc(doc(ctx.firestore(), `bookings/${b.id}`))).data().holdExpiresAt.toMillis();
    });

    for (const mins of [0, -60, MAX_EXTENSION_MINUTES + 1, 'soon', null]) {
      await assert.rejects(() => extendHold(staff(), b.id, mins, 'rec-1'), /between 1 minute/);
    }

    await env.withSecurityRulesDisabled(async ctx => {
      const still = (await getDoc(doc(ctx.firestore(), `bookings/${b.id}`))).data().holdExpiresAt.toMillis();
      assert.equal(still, was, 'the hold was left exactly as it was');
      assert.deepEqual((await getDocs(collection(ctx.firestore(), 'audit'))).docs.map(d => d.data().action), []);
    });
  });

  test('a hold whose nights were already taken cannot be extended', async () => {
    const lapsed = await seedLapsedBooking();
    await createBooking(guestB(), bookingInput({ uid: 'guest-b' }));   // took the nights
    await assert.rejects(() => extendHold(staff(), lapsed.id, 120, 'rec-1'), RoomUnavailableError);
  });

  test('a guest cannot extend their own hold', async () => {
    const b = await createBooking(guestA(), bookingInput());
    await assert.rejects(() => extendHold(guestA(), b.id, 120, 'guest-a'));
  });
});

describe('walk-ins and the front desk', () => {
  test('a walk-in is born confirmed, with no expiry and the rate already stamped', async () => {
    const b = await createBooking(staff(), bookingInput({
      uid: 'rec-1', source: 'walkin', status: 'confirmed', guestName: 'Juma Said' }));

    assert.equal(b.status, 'confirmed');
    assert.equal(b.holdExpiresAt, null);

    await env.withSecurityRulesDisabled(async ctx => {
      const cell = await getDoc(doc(ctx.firestore(), `nights/room-4_${D1}`));
      assert.equal(cell.data().status, 'confirmed');
      assert.equal(cell.data().holdExpiresAt, null);
      assert.equal(cell.data().rate, 30000);
    });
  });

  test('a walk-in cannot take a room a web guest is holding', async () => {
    await createBooking(guestA(), bookingInput());
    await assert.rejects(
      () => createBooking(staff(), bookingInput({
        uid: 'rec-1', source: 'walkin', status: 'confirmed' })),
      RoomUnavailableError);
  });

  test('a walk-in never lapses, however long it sits', async () => {
    await createBooking(staff(), bookingInput({
      uid: 'rec-1', source: 'walkin', status: 'confirmed' }));
    const wayLater = Date.now() + 365 * 24 * 3600_000;
    const blocked = await fetchAvailability(anon(), D1, D4, wayLater);
    assert.equal(isRoomFree(blocked, 'room-4', D1, D3), false);
  });

  test('the desk walks a stay from confirmed to checked out', async () => {
    const b = await createBooking(guestA(), bookingInput());
    await confirmBooking(staff(), b.id, 'rec-1');

    await checkInGuest(staff(), b.id, 'rec-1');
    await env.withSecurityRulesDisabled(async ctx => {
      assert.equal((await getDoc(doc(ctx.firestore(), `bookings/${b.id}`))).data().status, 'checked_in');
    });

    await checkOutGuest(staff(), b.id, 'rec-1');
    await env.withSecurityRulesDisabled(async ctx => {
      assert.equal((await getDoc(doc(ctx.firestore(), `bookings/${b.id}`))).data().status, 'checked_out');
    });
  });

  test('the status order is enforced, not merely suggested', async () => {
    const b = await createBooking(guestA(), bookingInput());
    // still pending: cannot check in before reception confirms
    await assert.rejects(() => checkInGuest(staff(), b.id, 'rec-1'), /is pending, expected confirmed/);
    await confirmBooking(staff(), b.id, 'rec-1');
    // confirmed but not arrived: cannot check out
    await assert.rejects(() => checkOutGuest(staff(), b.id, 'rec-1'), /expected checked_in/);
  });

  test('a checked-out stay still owns its nights, it is history not availability', async () => {
    const b = await createBooking(guestA(), bookingInput());
    await confirmBooking(staff(), b.id, 'rec-1');
    await checkInGuest(staff(), b.id, 'rec-1');
    await checkOutGuest(staff(), b.id, 'rec-1');

    await assert.rejects(
      () => createBooking(guestB(), bookingInput({ uid: 'guest-b' })),
      RoomUnavailableError);
  });
});

describe('folding the ledger', () => {
  // Regression: the console cached the folded result and refreshed it only when
  // a *booking* changed. Night cells change on their own — another terminal
  // taking a walk-in, a hold landing — and whether a hold still blocks depends
  // on the clock, not on any document changing. So folding must be cheap,
  // pure, and redone on every render.
  const cells = (over = []) => [
    { roomId: 'room-3', date: '2026-09-20', status: 'held', holdExpiresAt: new Date(Date.now() + 3600_000) },
    { roomId: 'room-3', date: '2026-09-21', status: 'confirmed', holdExpiresAt: null },
    { roomId: 'room-1', date: '2026-09-20', status: 'held', holdExpiresAt: new Date(Date.now() - 60_000) },
    ...over,
  ];

  test('groups live claims by room and drops lapsed ones', () => {
    const blocked = blockedFromCells(cells());
    assert.deepEqual([...blocked.get('room-3')].sort(), ['2026-09-20', '2026-09-21']);
    assert.equal(blocked.has('room-1'), false, 'the lapsed hold must not block');
  });

  test('the same cells fold differently as the clock moves', () => {
    const c = cells();
    const now   = blockedFromCells(c);
    const later = blockedFromCells(c, Date.now() + 2 * 3600_000);
    assert.equal(now.get('room-3').has('2026-09-20'), true);
    assert.equal(later.get('room-3').has('2026-09-20'), false, 'the hold has since lapsed');
    assert.equal(later.get('room-3').has('2026-09-21'), true, 'confirmed never lapses');
  });

  test('an empty ledger blocks nothing', () => {
    assert.equal(blockedFromCells([]).size, 0);
  });
});

describe('booking reference', () => {
  test('short and upper-case, so the guest and the desk read out the same thing', async () => {
    assert.equal(bookingReference('FqYY7pe3JeqL1QMCwUSc'), 'KL-FQYY7P');
    const b = await createBooking(guestA(), bookingInput());
    assert.match(bookingReference(b.id), /^KL-[A-Z0-9]{6}$/);
  });
});

describe('reading availability', () => {
  test('an anonymous visitor can see what is free without seeing who booked', async () => {
    await createBooking(guestA(), bookingInput());
    const rooms   = await loadRooms(anon());
    const blocked = await fetchAvailability(anon(), D1, D4);

    assert.deepEqual(rooms.map(r => r.number), [1, 2, 4, 6]);
    const free = freeRooms(rooms, blocked, D1, D3);
    assert.deepEqual(free.map(r => r.number), [1, 2], 'room 4 taken, room 6 inactive');

    // and the ledger really does carry no personal data
    await env.withSecurityRulesDisabled(async ctx => {
      const cells = await getDocs(collection(ctx.firestore(), 'nights'));
      cells.forEach(c => {
        const keys = Object.keys(c.data()).sort();
        assert.deepEqual(keys, ['bookingId', 'date', 'holdExpiresAt', 'roomId', 'status']);
      });
    });
  });
});

describe('the record', () => {
  async function auditEntries() {
    let entries = [];
    await env.withSecurityRulesDisabled(async ctx => {
      const snap = await getDocs(collection(ctx.firestore(), 'audit'));
      entries = snap.docs.map(d => d.data());
    });
    return entries;
  }

  test('a guest booking on the website writes no audit entry', async () => {
    await createBooking(guestA(), bookingInput());
    assert.deepEqual(await auditEntries(), []);
  });

  test('each desk action is recorded, by the person who did it', async () => {
    const b = await createBooking(guestA(), bookingInput());
    await confirmBooking(staff(), b.id, 'rec-1');
    await checkInGuest(staff(), b.id, 'rec-1');
    await checkOutGuest(staff(), b.id, 'rec-1');

    const entries = await auditEntries();
    assert.deepEqual(entries.map(e => e.action).sort(), ['check_in', 'check_out', 'confirm']);
    for (const e of entries) {
      assert.equal(e.actor, 'rec-1');
      assert.equal(e.bookingId, b.id);
      assert.ok(e.at, 'stamped with the server clock');
      assert.match(e.summary, /Amina Hassan · Room 4/);
    }
  });

  test('a walk-in, a decline with its reason, and a swept hold are all on the record', async () => {
    await createBooking(staff(), bookingInput({
      uid: 'rec-1', source: 'walkin', status: 'confirmed', roomId: 'room-1' }));
    const web = await createBooking(guestA(), bookingInput({ roomId: 'room-2' }));
    await cancelBooking(staff(), web.id, 'guest phoned to cancel', 'rec-1');
    await seedLapsedBooking();
    await sweepExpiredHolds(staff(), 'rec-1');

    const byAction = Object.fromEntries((await auditEntries()).map(e => [e.action, e]));
    assert.deepEqual(Object.keys(byAction).sort(), ['cancel', 'expire', 'walk_in']);
    assert.match(byAction.cancel.summary, /reason: guest phoned to cancel/);
    assert.deepEqual(byAction.cancel.after, { status: 'cancelled' });
    assert.match(byAction.expire.summary, /hold lapsed unanswered/);
  });

  test('a failed action leaves no record behind — the entry cannot outlive the change', async () => {
    const b = await createBooking(guestA(), bookingInput());
    await confirmBooking(staff(), b.id, 'rec-1');
    await assert.rejects(() => confirmBooking(staff(), b.id, 'rec-1'), /already confirmed/);
    await assert.rejects(() => checkOutGuest(staff(), b.id, 'rec-1'), /expected checked_in/);
    assert.deepEqual((await auditEntries()).map(e => e.action), ['confirm']);
  });
});
