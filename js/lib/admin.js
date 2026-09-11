// js/lib/admin.js
//
// What only the owner does: change a room's price, take a room off sale, and
// read the record of who did what.
//
// The security rules are the real boundary here. Reception is refused by the
// database, not merely by a tab it cannot see. Every change writes its audit
// entry in the same transaction as the change itself.

import {
  doc, collection, getDocs, query, where, orderBy, limit,
  runTransaction, serverTimestamp,
} from 'firebase/firestore';

import { auditEntry } from './audit.js';
import { BookingError } from './availability.js';

export const MIN_RATE = 1_000;
export const MAX_RATE = 10_000_000;

const tsh = n => Number(n).toLocaleString('en-GB');

/** Turns what the owner typed into a price, or explains why it is not one.
 *  Mirrors the rules, so a bad price is refused before anything is sent. */
export function checkRate(value) {
  const text = String(value ?? '').replace(/[,\s]/g, '');
  if (!/^\d+$/.test(text)) {
    throw new BookingError('Enter the price as a whole number of shillings, like 35000.');
  }
  const rate = Number(text);
  if (rate < MIN_RATE || rate > MAX_RATE) {
    throw new BookingError(`A night must cost between ${tsh(MIN_RATE)} and ${tsh(MAX_RATE)} TSH.`);
  }
  return rate;
}

/**
 * Change a room's price and/or whether it is on sale. Bookings already made
 * keep the price they were made at — the rate is snapshotted onto each booking
 * and each confirmed night — so this only affects bookings taken afterwards.
 */
export async function updateRoom(db, roomId, changes, adminUid) {
  const next = {};
  if ('rate' in changes) next.rate = checkRate(changes.rate);
  if ('active' in changes) {
    if (typeof changes.active !== 'boolean') throw new BookingError('active must be true or false');
    next.active = changes.active;
  }
  if (!Object.keys(next).length) throw new BookingError('nothing to change');

  return runTransaction(db, async tx => {
    const ref  = doc(db, 'rooms', roomId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new BookingError(`unknown room ${roomId}`);
    const current = snap.data();

    const before = {};
    const after  = {};
    for (const [key, value] of Object.entries(next)) {
      if (current[key] !== value) {
        before[key] = current[key] ?? null;
        after[key]  = value;
      }
    }
    // Saving what is already there changes nothing and records nothing.
    if (!Object.keys(after).length) return { roomId, changed: false };

    tx.update(ref, { ...after, updatedAt: serverTimestamp(), updatedBy: adminUid });
    tx.set(doc(collection(db, 'audit')), auditEntry(adminUid, 'room_update', {
      roomId,
      summary: describeRoomChange(current, before, after),
      before,
      after,
    }));
    return { roomId, changed: true, before, after };
  });
}

function describeRoomChange(room, before, after) {
  const parts = [];
  if ('rate' in after)   parts.push(`price ${tsh(before.rate)} → ${tsh(after.rate)} TSH a night`);
  if ('active' in after) parts.push(after.active ? 'put back on sale' : 'taken off sale');
  return `Room ${room.number}: ${parts.join(', ')}`;
}

/** Newest first. The rules let only the owner read this. */
export async function loadAudit(db, max = 100) {
  const snap = await getDocs(query(collection(db, 'audit'), orderBy('at', 'desc'), limit(max)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function loadStaff(db) {
  const snap = await getDocs(collection(db, 'staff'));
  return snap.docs
    .map(d => ({ uid: d.id, ...d.data() }))
    .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
}

/** Every ledger cell in an inclusive span of nights — the raw material for reports. */
export async function loadNightCells(db, from, to) {
  const snap = await getDocs(query(
    collection(db, 'nights'),
    where('date', '>=', from),
    where('date', '<=', to),
  ));
  return snap.docs.map(d => d.data());
}
