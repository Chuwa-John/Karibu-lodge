// tests/rules.test.js — exercises firestore.rules against the emulator.
// Start it first:  npm run emu
import { test, before, after, beforeEach, describe } from 'node:test';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';

let env;
const HOST = '127.0.0.1', PORT = 8081;

const inHours = h => new Date(Date.now() + h * 3600000);

const guest     = () => env.authenticatedContext('guest-abc').firestore();
const other     = () => env.authenticatedContext('guest-xyz').firestore();
const anon      = () => env.unauthenticatedContext().firestore();
const reception = () => env.authenticatedContext('rec-1', { role: 'reception' }).firestore();
const admin     = () => env.authenticatedContext('adm-1', { role: 'admin' }).firestore();

const hold = (over = {}) => ({
  roomId: 'room-4', date: '2026-09-20', bookingId: 'bk1',
  status: 'held', holdExpiresAt: inHours(2), ...over,
});

const booking = (over = {}) => ({
  roomId: 'room-4', roomNumber: 4,
  guestName: 'Amina Hassan', guestPhone: '+255700000000',
  checkIn: '2026-09-20', checkOut: '2026-09-22', nights: 2,
  ratePerNight: 30000, total: 60000,
  status: 'pending', source: 'web', createdBy: 'guest-abc',
  holdExpiresAt: inHours(2), createdAt: new Date(), ...over,
});

/** Write past the rules, to set up state a guest could never create. */
async function seed(path, data) {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-karibu-rules',
    firestore: { host: HOST, port: PORT, rules: readFileSync('firestore.rules', 'utf8') },
  });
});

after(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await seed('rooms/room-4', { number: 4, type: 'deluxe',   rate: 30000, active: true });
  await seed('rooms/room-2', { number: 2, type: 'standard', rate: 20000, active: true });
});

describe('rooms', () => {
  test('anyone may read the catalogue', async () => {
    await assertSucceeds(getDoc(doc(anon(), 'rooms/room-4')));
  });
  test('reception may not change a rate', async () => {
    await assertFails(updateDoc(doc(reception(), 'rooms/room-4'), { rate: 1000 }));
  });
  test('reception may not take a room off sale', async () => {
    await assertFails(updateDoc(doc(reception(), 'rooms/room-4'), { active: false }));
  });
  test('the owner may change a rate', async () => {
    await assertSucceeds(updateDoc(doc(admin(), 'rooms/room-4'), { rate: 35000 }));
  });
  test('the owner may take a room off sale and put it back', async () => {
    await assertSucceeds(updateDoc(doc(admin(), 'rooms/room-4'), { active: false }));
    await assertSucceeds(updateDoc(doc(admin(), 'rooms/room-4'), { active: true }));
  });
  test('a price must be a whole number of shillings in a sane range', async () => {
    for (const rate of [0, -1, 999, 25000.5, '30000', 10000001, null]) {
      await assertFails(updateDoc(doc(admin(), 'rooms/room-4'), { rate }));
    }
  });
  test('"on sale" must be a real true or false', async () => {
    await assertFails(updateDoc(doc(admin(), 'rooms/room-4'), { active: 'no' }));
  });
  test('the owner cannot renumber, retype or relabel a room — that is what guests booked', async () => {
    await assertFails(updateDoc(doc(admin(), 'rooms/room-4'), { number: 9 }));
    await assertFails(updateDoc(doc(admin(), 'rooms/room-4'), { type: 'standard' }));
    await assertFails(updateDoc(doc(admin(), 'rooms/room-4'), { label: 'Penthouse' }));
  });
  test('a room is never deleted — bookings and the ledger point at it', async () => {
    await assertFails(deleteDoc(doc(admin(), 'rooms/room-4')));
  });
  test('the owner cannot create a malformed room', async () => {
    await assertFails(setDoc(doc(admin(), 'rooms/room-7'), { number: 7, type: 'suite', rate: 50000, active: true }));
    await assertSucceeds(setDoc(doc(admin(), 'rooms/room-7'), { number: 7, type: 'deluxe', rate: 50000, active: true }));
  });
});

describe('nights ledger', () => {
  test('availability is world-readable', async () => {
    await assertSucceeds(getDocs(collection(anon(), 'nights')));
  });
  test('a signed-in guest may place a short hold', async () => {
    await assertSucceeds(setDoc(doc(guest(), 'nights/room-4_2026-09-20'), hold()));
  });
  test('an anonymous visitor may not', async () => {
    await assertFails(setDoc(doc(anon(), 'nights/room-4_2026-09-20'), hold()));
  });
  test('the doc id must match roomId and date', async () => {
    await assertFails(setDoc(doc(guest(), 'nights/room-4_2026-09-21'), hold()));
  });
  test('a guest may not hold a room for a week', async () => {
    await assertFails(setDoc(doc(guest(), 'nights/room-4_2026-09-20'),
      hold({ holdExpiresAt: inHours(24 * 7) })));
  });
  test('a guest may not write a confirmed cell', async () => {
    await assertFails(setDoc(doc(guest(), 'nights/room-4_2026-09-20'),
      hold({ status: 'confirmed' })));
  });
  test('a guest may not smuggle a rate onto a cell', async () => {
    await assertFails(setDoc(doc(guest(), 'nights/room-4_2026-09-20'), hold({ rate: 1 })));
  });

  test('a live hold blocks another guest', async () => {
    await setDoc(doc(guest(), 'nights/room-4_2026-09-20'), hold());
    await assertFails(setDoc(doc(other(), 'nights/room-4_2026-09-20'), hold({ bookingId: 'bk2' })));
  });

  test('an expired hold does not block', async () => {
    await seed('nights/room-4_2026-09-20', hold({ holdExpiresAt: inHours(-1) }));
    await assertSucceeds(setDoc(doc(other(), 'nights/room-4_2026-09-20'), hold({ bookingId: 'bk2' })));
  });

  test('a confirmed cell blocks even after its hold time passes', async () => {
    await seed('nights/room-4_2026-09-20',
      { ...hold(), status: 'confirmed', holdExpiresAt: null, rate: 30000 });
    await assertFails(setDoc(doc(other(), 'nights/room-4_2026-09-20'), hold({ bookingId: 'bk2' })));
  });

  test('only staff may release a night', async () => {
    await setDoc(doc(guest(), 'nights/room-4_2026-09-20'), hold());
    await assertFails(deleteDoc(doc(other(), 'nights/room-4_2026-09-20')));
    await assertSucceeds(deleteDoc(doc(reception(), 'nights/room-4_2026-09-20')));
  });
});

/** The first hold of a new window, counted the way the engine counts it. */
const counting = (over = {}) => ({ count: 1, windowStart: serverTimestamp(), ...over });

/**
 * A booking as the site actually sends it: the booking and the count against
 * the hold limit in ONE commit. Neither is allowed without the other, so a
 * test that means to check something else must still send both.
 */
function guestBooks(db, { id = 'bk1', uid = 'guest-abc', data = {}, counted = counting() } = {}) {
  const batch = writeBatch(db);
  batch.set(doc(db, `bookings/${id}`), booking(data));
  if (counted) batch.set(doc(db, `webHolds/${uid}`), counted);
  return batch.commit();
}

describe('bookings', () => {
  test('a guest may submit a pending booking', async () => {
    await assertSucceeds(guestBooks(guest()));
  });

  test('a guest may not read bookings, those are other peoples phone numbers', async () => {
    await seed('bookings/bk1', booking());
    await assertFails(getDoc(doc(guest(), 'bookings/bk1')));
    await assertFails(getDocs(collection(guest(), 'bookings')));
    await assertSucceeds(getDoc(doc(reception(), 'bookings/bk1')));
  });

  test('a guest may not invent their own rate', async () => {
    await assertFails(guestBooks(guest(), { data: { ratePerNight: 1, total: 2 } }));
  });
  test('the total must match rate x nights', async () => {
    await assertFails(guestBooks(guest(), { data: { total: 100 } }));
  });
  test('a guest may not self-confirm', async () => {
    await assertFails(guestBooks(guest(), { data: { status: 'confirmed' } }));
  });
  test('a guest may not book a room that does not exist', async () => {
    await assertFails(guestBooks(guest(), { data: { roomId: 'room-99' } }));
  });
  test('checkOut must be after checkIn', async () => {
    await assertFails(guestBooks(guest(), { data: { checkIn: '2026-09-22', checkOut: '2026-09-20' } }));
  });
  test('a guest may not impersonate another uid', async () => {
    await assertFails(guestBooks(guest(), { data: { createdBy: 'someone-else' } }));
  });

  test('reception may confirm but may not touch the money', async () => {
    await seed('bookings/bk1', booking());
    await assertSucceeds(updateDoc(doc(reception(), 'bookings/bk1'), { status: 'confirmed' }));
    await assertFails(updateDoc(doc(reception(), 'bookings/bk1'), { total: 0 }));
    await assertSucceeds(updateDoc(doc(admin(), 'bookings/bk1'), { total: 0 }));
  });

  test('nobody may delete a booking, not even the admin', async () => {
    await seed('bookings/bk1', booking());
    await assertFails(deleteDoc(doc(reception(), 'bookings/bk1')));
    await assertFails(deleteDoc(doc(admin(), 'bookings/bk1')));
  });
});

describe('how many rooms one visitor may hold', () => {
  // A hold is free and takes a room off sale for two hours. Without a limit,
  // one bored visitor empties the lodge for the afternoon in six clicks.
  const startedHoursAgo = h => new Date(Date.now() - h * 3600000);

  test('a booking that does not count itself is refused', async () => {
    await assertFails(guestBooks(guest(), { counted: null }));
  });

  test('a fourth hold inside the same two hours is refused', async () => {
    const started = startedHoursAgo(1);
    await seed('webHolds/guest-abc', { count: 3, windowStart: started });
    await assertFails(guestBooks(guest(), { counted: { count: 4, windowStart: started } }));
  });

  test('the third is still allowed — the limit is three, not two', async () => {
    const started = startedHoursAgo(1);
    await seed('webHolds/guest-abc', { count: 2, windowStart: started });
    await assertSucceeds(guestBooks(guest(), { counted: { count: 3, windowStart: started } }));
  });

  test('once the two hours have passed the count starts again', async () => {
    await seed('webHolds/guest-abc', { count: 3, windowStart: startedHoursAgo(3) });
    await assertSucceeds(guestBooks(guest()));
  });

  test('a guest cannot start a fresh window early to clear the count', async () => {
    await seed('webHolds/guest-abc', { count: 3, windowStart: startedHoursAgo(1) });
    await assertFails(guestBooks(guest()));
  });

  test('a guest cannot backdate the window to make it look spent', async () => {
    await assertFails(guestBooks(guest(), { counted: counting({ windowStart: startedHoursAgo(3) }) }));
  });

  test('a guest cannot skip a number, or count down', async () => {
    const started = startedHoursAgo(1);
    await seed('webHolds/guest-abc', { count: 1, windowStart: started });
    await assertFails(guestBooks(guest(), { counted: { count: 1, windowStart: started } }));
    await assertFails(guestBooks(guest(), { counted: { count: 0, windowStart: started } }));
    await assertSucceeds(guestBooks(guest(), { counted: { count: 2, windowStart: started } }));
  });

  test('a guest cannot put their hold on someone else’s count', async () => {
    await assertFails(guestBooks(guest(), { uid: 'guest-xyz' }));
  });

  test('the count is the visitor’s own business, and cannot be deleted', async () => {
    await seed('webHolds/guest-abc', { count: 1, windowStart: startedHoursAgo(1) });
    await assertSucceeds(getDoc(doc(guest(), 'webHolds/guest-abc')));
    await assertFails(getDoc(doc(other(), 'webHolds/guest-abc')));
    await assertFails(deleteDoc(doc(guest(), 'webHolds/guest-abc')));
  });

  test('the desk is not limited — a walk-in is a guest standing there', async () => {
    await assertSucceeds(setDoc(doc(reception(), 'bookings/walk1'),
      booking({ source: 'walkin', status: 'confirmed', createdBy: 'rec-1', holdExpiresAt: null })));
  });
});

describe('audit', () => {
  const entry = (over = {}) => ({
    actor: 'rec-1', action: 'confirm', summary: 'Amina Hassan · Room 4',
    at: serverTimestamp(), ...over,
  });

  test('staff append; only the owner reads; nobody rewrites or deletes', async () => {
    await assertSucceeds(setDoc(doc(reception(), 'audit/a1'), entry()));
    await assertFails(getDoc(doc(reception(), 'audit/a1')));
    await assertSucceeds(getDoc(doc(admin(), 'audit/a1')));
    await assertFails(updateDoc(doc(admin(), 'audit/a1'), { summary: 'tampered' }));
    await assertFails(deleteDoc(doc(admin(), 'audit/a1')));
  });

  test('an entry cannot be written in someone else’s name', async () => {
    await assertFails(setDoc(doc(reception(), 'audit/a2'), entry({ actor: 'adm-1' })));
  });

  test('an entry cannot be backdated — only the server clock may stamp it', async () => {
    await assertFails(setDoc(doc(reception(), 'audit/a3'),
      entry({ at: new Date(Date.now() - 3600000) })));
  });

  test('only known actions and known fields, and a summary is required', async () => {
    await assertFails(setDoc(doc(reception(), 'audit/a4'), entry({ action: 'delete_everything' })));
    await assertFails(setDoc(doc(reception(), 'audit/a5'), entry({ secret: 'x' })));
    const noSummary = entry();
    delete noSummary.summary;
    await assertFails(setDoc(doc(reception(), 'audit/a6'), noSummary));
    await assertSucceeds(setDoc(doc(admin(), 'audit/a7'),
      entry({ actor: 'adm-1', action: 'room_update', roomId: 'room-4',
              before: { rate: 30000 }, after: { rate: 35000 } })));
  });

  test('a guest cannot write to the record at all', async () => {
    await assertFails(setDoc(doc(guest(), 'audit/a8'), entry({ actor: 'guest-abc' })));
  });
});
