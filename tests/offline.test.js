// tests/offline.test.js — what happens when there is no connection.
// Needs no emulator: the whole point is a backend that cannot be reached.
//
// The promise being tested: nothing that changes a booking can be made offline
// and delivered later. It fails, it says so in plain words, and when the
// connection comes back nothing turns up that nobody saw happen.
//
// How "offline" is simulated, and why: measured 2026-09-11, disableNetwork()
// does NOT stop a transaction — a booking made with the network "disabled"
// committed on the server and was readable there while it was still disabled.
// So offline is simulated the honest way, by pointing a client at a port
// nothing is listening on.
//
// The mechanism behind the promise is that every write in js/lib is inside
// runTransaction (guarded by tests/no-queued-writes.test.js). A plain write is
// queued locally and delivered whenever the connection returns, possibly long
// after whoever made it walked away; a transaction needs a live server for its
// reads and fails instead. The last test here holds that difference still.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getFirestore, connectFirestoreEmulator, terminate,
  doc, setDoc, getDocFromCache,
} from 'firebase/firestore';

import { createBooking, confirmBooking, RoomUnavailableError } from '../js/lib/availability.js';
import { explainError } from '../js/lib/errors.js';
import { addDays, today } from '../js/lib/dates.js';

/** Discard port: reserved by RFC 863 and nothing listens on it here, so every
 *  request is refused rather than hanging until some far-off timeout. */
const NOWHERE = 9;

const D1 = addDays(today(), 30);
const D3 = addDays(today(), 32);

const apps = [];
function offlineDb(name) {
  const app = initializeApp({ projectId: 'demo-karibu-offline' }, `${name}-${Date.now()}`);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', NOWHERE);
  apps.push({ app, db });
  return db;
}

after(async () => {
  // Without this the SDK keeps retrying the dead host and node never exits.
  for (const { app, db } of apps) {
    await terminate(db).catch(() => {});
    await deleteApp(app).catch(() => {});
  }
});

/** Assert a failure is a lost connection, and that the words the guest or the
 *  desk actually sees say so. `online: true` deliberately ignores this
 *  machine's own network state: the message must come from the error itself. */
function assertReadsAsNoConnection(err, what) {
  assert.ok(err, `${what} must not quietly succeed with no connection`);
  assert.ok(!(err instanceof RoomUnavailableError), `${what} failed for want of a connection, not a room`);
  assert.equal(err.code, 'unavailable', `${what}: unexpected code (${err.code}: ${err.message})`);
  assert.match(explainError(err, { online: true }), /^No connection\./,
    `${what} is explained as: ${explainError(err, { online: true })}`);
}

describe('with no connection', () => {
  test('a guest booking fails, and fails quickly', { timeout: 60_000 }, async () => {
    const db = offlineDb('guest');
    const started = Date.now();

    const err = await createBooking(db, {
      roomId: 'room-4', checkIn: D1, checkOut: D3,
      guestName: 'Offline Guest', guestPhone: '+255700000000', uid: 'guest-a',
    }).then(() => null, e => e);

    assertReadsAsNoConnection(err, 'a guest booking');
    // It gives up on the first read rather than retrying: the guest is told in
    // a couple of seconds, not left watching a spinner.
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms to say so`);
  });

  test('a desk confirmation fails, and nothing is left half-done', { timeout: 60_000 }, async () => {
    const db = offlineDb('desk');

    const err = await confirmBooking(db, 'whatever-id', 'rec-1').then(() => null, e => e);

    assertReadsAsNoConnection(err, 'a desk confirmation');
  });

  test('a plain write is neither done nor refused — it just waits, which is why nothing here writes that way', { timeout: 60_000 }, async () => {
    const db = offlineDb('contrast');
    const ref = doc(db, 'scratch/queued');

    // Never awaited, because with the backend unreachable it never settles:
    // setDoc resolves on the server's acknowledgement, and there is no server.
    // Meanwhile the change is already in the local cache and the SDK keeps
    // retrying it for as long as the tab is open (measured: still going after
    // a minute, backing off 1s, 2s, 4s, 7s, 11s, 17s…).
    let settled = null;
    setDoc(ref, { ok: true }).then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });

    const cached = await getDocFromCache(ref);
    assert.equal(cached.data().ok, true, 'nobody refused it');
    assert.ok(cached.metadata.hasPendingWrites, 'it is waiting to be sent');

    await new Promise(r => setTimeout(r, 3000));
    assert.equal(settled, null, 'the caller is left waiting, with the write still queued');

    // A room claimed this way would be taken minutes later, from a guest who
    // was told nothing, by which time the desk may have sold it to someone
    // standing at the counter. The two tests above are the contrast: every
    // write in js/lib goes through a transaction, and a transaction refuses
    // instead of waiting. tests/no-queued-writes.test.js keeps it that way.
  });
});
