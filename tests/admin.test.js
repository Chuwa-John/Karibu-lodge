// tests/admin.test.js — the owner's actions, against the emulator with rules ON.
// Start it first:  npm run emu
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore';
import { readFileSync } from 'node:fs';

import { updateRoom, checkRate, loadAudit, loadStaff } from '../js/lib/admin.js';
import { createBooking, confirmBooking } from '../js/lib/availability.js';
import { addDays, today } from '../js/lib/dates.js';

let env;
const HOST = '127.0.0.1', PORT = 8081;
const D1 = addDays(today(), 20);
const D3 = addDays(today(), 22);

const owner     = () => env.authenticatedContext('adm-1', { role: 'admin' }).firestore();
const reception = () => env.authenticatedContext('rec-1', { role: 'reception' }).firestore();
const guest     = () => env.authenticatedContext('guest-a').firestore();

async function asRoot(fn) {
  let out;
  await env.withSecurityRulesDisabled(async ctx => { out = await fn(ctx.firestore()); });
  return out;
}
const room    = id => asRoot(async db => (await getDoc(doc(db, `rooms/${id}`))).data());
const entries = () => asRoot(async db => (await getDocs(collection(db, 'audit'))).docs.map(d => d.data()));

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-karibu-admin',
    firestore: { host: HOST, port: PORT, rules: readFileSync('firestore.rules', 'utf8') },
  });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await asRoot(async db => {
    await setDoc(doc(db, 'rooms/room-4'), { number: 4, type: 'deluxe',   rate: 30000, active: true });
    await setDoc(doc(db, 'rooms/room-2'), { number: 2, type: 'standard', rate: 20000, active: true });
    await setDoc(doc(db, 'staff/rec-1'), { name: 'Front Desk', email: 'reception@karibu.co.tz', role: 'reception', active: true });
    await setDoc(doc(db, 'staff/adm-1'), { name: 'Anna Owner', email: 'owner@karibu.co.tz', role: 'admin', active: true });
  });
});

describe('prices', () => {
  test('the owner changes a rate, and the change and its record land together', async () => {
    const r = await updateRoom(owner(), 'room-4', { rate: '35,000' }, 'adm-1');
    assert.equal(r.changed, true);
    assert.equal((await room('room-4')).rate, 35000);

    const [entry] = await entries();
    assert.equal(entry.action, 'room_update');
    assert.equal(entry.actor, 'adm-1');
    assert.deepEqual(entry.before, { rate: 30000 });
    assert.deepEqual(entry.after, { rate: 35000 });
    assert.match(entry.summary, /Room 4: price 30,000 → 35,000 TSH a night/);
  });

  test('a price the database would refuse is refused before anything is sent', async () => {
    for (const bad of ['0', '-1', '999', '25000.5', 'abc', '', '20000000']) {
      await assert.rejects(() => updateRoom(owner(), 'room-4', { rate: bad }, 'adm-1'), /shillings|between/, bad);
    }
    assert.equal((await room('room-4')).rate, 30000);
    assert.deepEqual(await entries(), []);
  });

  test('checkRate reads what people actually type', () => {
    assert.equal(checkRate('35000'), 35000);
    assert.equal(checkRate(' 35,000 '), 35000);
    assert.equal(checkRate(35000), 35000);
  });

  test('saving the price that is already there changes nothing and records nothing', async () => {
    const r = await updateRoom(owner(), 'room-4', { rate: 30000 }, 'adm-1');
    assert.equal(r.changed, false);
    assert.deepEqual(await entries(), []);
  });

  test('reception is refused by the database, and nothing half-lands', async () => {
    await assert.rejects(() => updateRoom(reception(), 'room-4', { rate: 1000 }, 'rec-1'),
      err => err.code === 'permission-denied');
    assert.equal((await room('room-4')).rate, 30000, 'price untouched');
    assert.deepEqual(await entries(), [], 'and no audit entry claiming it happened');
  });

  test('bookings already made keep the price they were made at', async () => {
    const b = await createBooking(guest(), {
      roomId: 'room-4', checkIn: D1, checkOut: D3,
      guestName: 'Amina Hassan', guestPhone: '+255700000000', uid: 'guest-a',
    });
    await updateRoom(owner(), 'room-4', { rate: 45000 }, 'adm-1');
    await confirmBooking(reception(), b.id, 'rec-1');

    const booking = await asRoot(async db => (await getDoc(doc(db, `bookings/${b.id}`))).data());
    assert.equal(booking.ratePerNight, 30000);
    assert.equal(booking.total, 60000);
    const night = await asRoot(async db => (await getDoc(doc(db, `nights/room-4_${D1}`))).data());
    assert.equal(night.rate, 30000, 'the confirmed night carries the agreed price into reports');
  });
});

describe('taking a room off sale', () => {
  test('stops new bookings for it, and goes on the record', async () => {
    await updateRoom(owner(), 'room-2', { active: false }, 'adm-1');
    await assert.rejects(() => createBooking(guest(), {
      roomId: 'room-2', checkIn: D1, checkOut: D3,
      guestName: 'Juma Said', guestPhone: '+255700000001', uid: 'guest-a',
    }), /not bookable/);

    const [entry] = await entries();
    assert.match(entry.summary, /Room 2: taken off sale/);
  });

  test('putting it back on sale opens it again', async () => {
    await updateRoom(owner(), 'room-2', { active: false }, 'adm-1');
    await updateRoom(owner(), 'room-2', { active: true }, 'adm-1');
    const b = await createBooking(guest(), {
      roomId: 'room-2', checkIn: D1, checkOut: D3,
      guestName: 'Juma Said', guestPhone: '+255700000001', uid: 'guest-a',
    });
    assert.equal(b.status, 'pending');
    assert.equal((await entries()).length, 2);
  });

  test('nonsense for "active" is refused', async () => {
    await assert.rejects(() => updateRoom(owner(), 'room-2', { active: 'no' }, 'adm-1'), /true or false/);
  });
});

describe('reading the record and the staff list', () => {
  test('the owner reads the record newest first', async () => {
    await updateRoom(owner(), 'room-4', { rate: 31000 }, 'adm-1');
    await updateRoom(owner(), 'room-4', { rate: 32000 }, 'adm-1');
    const log = await loadAudit(owner());
    assert.deepEqual(log.map(e => e.after.rate), [32000, 31000]);
  });

  test('reception cannot read the record', async () => {
    await assert.rejects(() => loadAudit(reception()), err => err.code === 'permission-denied');
  });

  test('staff can see who works here, sorted by name', async () => {
    const people = await loadStaff(owner());
    assert.deepEqual(people.map(p => p.name), ['Anna Owner', 'Front Desk']);
    await assert.rejects(() => loadStaff(guest()), err => err.code === 'permission-denied');
  });
});
