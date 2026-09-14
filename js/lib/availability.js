// js/lib/availability.js
//
// The allocation engine. Everything that can double-book a room lives here.
//
// The model: one document per room per night, id `{roomId}_{YYYY-MM-DD}`, in
// the `nights` collection. Claiming a stay means creating every one of those
// documents inside a single Firestore transaction. Because the transaction
// records the version it read for each cell — including "did not exist" — a
// concurrent booking that beats us to a night makes our commit fail, and the
// SDK re-runs the whole thing. On the re-run we see the cell is taken and give
// up cleanly.
//
// This is why availability is addressed by document key rather than found with
// an overlap query: the client SDK cannot run a query inside a transaction, so
// a query-based check has a race between the read and the write that nothing
// on the client can close.

import {
  doc, collection, getDoc, getDocs, query, where,
  runTransaction, serverTimestamp, Timestamp,
} from 'firebase/firestore';

import { nightsBetween, nightKey, today } from './dates.js';
import { auditEntry, describeBooking } from './audit.js';

/** How long a web booking holds a room before reception has to act on it. */
export const HOLD_MINUTES = 120;

/** How many rooms one visitor may take off sale from the website, and over
 *  what stretch of time. A hold costs the guest nothing, so without this one
 *  visitor could hold all six rooms and empty the lodge for the afternoon.
 *  Reception is not limited: a walk-in at the desk is a real guest standing
 *  there. See firestore.rules — the same numbers are enforced server-side. */
export const MAX_WEB_HOLDS = 3;
export const HOLD_WINDOW_MINUTES = 120;

/** Statuses that mean the booking still has a claim on its nights. */
export const LIVE_STATUSES = ['pending', 'confirmed', 'checked_in'];

export class RoomUnavailableError extends Error {
  constructor(roomId, takenDates) {
    super(`Room ${roomId} is already taken on ${takenDates.join(', ')}`);
    this.name = 'RoomUnavailableError';
    this.roomId = roomId;
    this.takenDates = takenDates;
  }
}

export class BookingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BookingError';
  }
}

export class HoldLimitError extends Error {
  constructor(max = MAX_WEB_HOLDS, windowMinutes = HOLD_WINDOW_MINUTES) {
    super(`only ${max} rooms may be held from one device every ${windowMinutes} minutes`);
    this.name = 'HoldLimitError';
    this.max = max;
    this.windowMinutes = windowMinutes;
  }
}

/** The short reference a guest is shown and reception can read back to them.
 *  Both sides call this, so they can never disagree about the format. */
export function bookingReference(id) {
  return 'KL-' + String(id || '').slice(0, 6).toUpperCase();
}

/* ── Cell interpretation ──────────────────────────────────────────
   A cell blocks unless it is a hold that has already lapsed. This one
   predicate is what makes hold expiry work without a scheduled job:
   nothing has to run for a stale hold to stop blocking.               */

function toMillis(ts) {
  if (ts == null) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  return new Date(ts).getTime();
}

export function cellBlocks(data, nowMs = Date.now()) {
  if (!data) return false;
  if (data.status !== 'held') return true;      // confirmed / checked_in: always
  const expiry = toMillis(data.holdExpiresAt);
  if (expiry == null) return true;              // a hold with no expiry never lapses
  return expiry > nowMs;                        // still within its two hours
}

/* ── Reads ────────────────────────────────────────────────────── */

export async function loadRooms(db) {
  const snap = await getDocs(collection(db, 'rooms'));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.number - b.number);
}

/**
 * Which nights are spoken for, per room, across an inclusive date span.
 * Returns Map<roomId, Set<'YYYY-MM-DD'>>. Reads the PII-free ledger only,
 * so this works for an anonymous visitor.
 */
export async function fetchAvailability(db, from, to, nowMs = Date.now()) {
  const snap = await getDocs(query(
    collection(db, 'nights'),
    where('date', '>=', from),
    where('date', '<=', to),
  ));
  return blockedFromCells(snap.docs.map(d => d.data()), nowMs);
}

/**
 * Fold raw night documents into Map<roomId, Set<date>>.
 *
 * Kept separate from the fetch so a live listener can hold the raw cells and
 * re-fold them on a timer: whether a hold still blocks depends on the clock,
 * not on any document changing, so a view that folds once and caches the
 * result will keep showing a lapsed hold as occupied.
 */
export function blockedFromCells(cells, nowMs = Date.now()) {
  const blocked = new Map();
  for (const d of cells) {
    if (!cellBlocks(d, nowMs)) continue;
    if (!blocked.has(d.roomId)) blocked.set(d.roomId, new Set());
    blocked.get(d.roomId).add(d.date);
  }
  return blocked;
}

/** Is this room free for the whole stay, given a fetchAvailability() result? */
export function isRoomFree(blocked, roomId, checkIn, checkOut) {
  const taken = blocked.get(roomId);
  if (!taken) return true;
  return nightsBetween(checkIn, checkOut).every(d => !taken.has(d));
}

/** Rooms free for the whole stay. */
export function freeRooms(rooms, blocked, checkIn, checkOut) {
  return rooms.filter(r => r.active !== false && isRoomFree(blocked, r.id, checkIn, checkOut));
}

/* ── The hold allowance ───────────────────────────────────────── */

/**
 * What webHolds/{uid} should say once this hold is counted, given what it says
 * now. Throws HoldLimitError when this visitor has had their share of the
 * current window.
 *
 * A counter that has run out of time starts again from 1 rather than being
 * cleared by anything scheduled — the same trick as a lapsed hold: nothing has
 * to run for the allowance to come back.
 */
export function nextAllowance(snap, nowMs = Date.now()) {
  const prev = snap?.exists?.() ? snap.data() : null;
  const startedMs = prev ? toMillis(prev.windowStart) : null;
  const windowOpen = startedMs != null
    && Number.isInteger(prev.count)
    && startedMs > nowMs - HOLD_WINDOW_MINUTES * 60_000;

  if (!windowOpen) return { windowStart: serverTimestamp(), count: 1 };
  if (prev.count >= MAX_WEB_HOLDS) throw new HoldLimitError();
  return { windowStart: prev.windowStart, count: prev.count + 1 };
}

/* ── The booking transaction ──────────────────────────────────── */

/**
 * Claim a room for a stay. Either every night is claimed and the booking is
 * written, or nothing happens at all.
 *
 * Throws RoomUnavailableError naming the specific nights that were taken —
 * that error aborts without a retry, which is what we want: a genuinely
 * occupied room should fail fast, not spin.
 */
export async function createBooking(db, input) {
  const {
    roomId, checkIn, checkOut, guestName, guestPhone,
    uid, source = 'web', notes = '', holdMinutes = HOLD_MINUTES,
    status = 'pending',
  } = input;

  const nights = nightsBetween(checkIn, checkOut);   // throws on bad dates / over the cap
  if (checkIn < today()) throw new BookingError('check-in date is in the past');
  if (!uid) throw new BookingError('a signed-in uid is required');

  const name  = String(guestName ?? '').trim();
  const phone = String(guestPhone ?? '').replace(/[\s()-]/g, '');
  if (name.length < 2 || name.length > 100) throw new BookingError('guest name must be 2-100 characters');
  if (!/^\+?[0-9]{9,15}$/.test(phone))      throw new BookingError('guest phone is not a valid number');

  const roomSnap = await getDoc(doc(db, 'rooms', roomId));
  if (!roomSnap.exists())        throw new BookingError(`unknown room ${roomId}`);
  const room = roomSnap.data();
  if (room.active !== true)      throw new BookingError(`room ${roomId} is not bookable`);

  // A walk-in taken at the desk is already agreed, so it is created confirmed
  // and its nights never carry an expiry.
  const bornConfirmed = status === 'confirmed';

  const ratePerNight  = room.rate;
  const total         = ratePerNight * nights.length;
  const holdExpiresAt = bornConfirmed
    ? null
    : Timestamp.fromMillis(Date.now() + holdMinutes * 60_000);

  const bookingRef = doc(collection(db, 'bookings'));
  const cellRefs   = nights.map(d => doc(db, 'nights', nightKey(roomId, d)));

  // Only a hold placed from the website counts against the limit. A walk-in is
  // a guest at the desk, and reception is trusted with the rooms anyway.
  const allowanceRef = source === 'web' && !bornConfirmed ? doc(db, 'webHolds', uid) : null;

  const booking = {
    roomId,
    roomNumber: room.number,
    guestName: name,
    guestPhone: phone,
    checkIn, checkOut,
    nights: nights.length,
    ratePerNight,           // snapshot: a later rate change must not rewrite history
    total,
    status,
    source,
    notes,
    createdBy: uid,
    holdExpiresAt,
    createdAt: serverTimestamp(),
  };

  await runTransaction(db, async tx => {
    // Every read must happen before every write, so gather all cells first.
    const snaps = await Promise.all(cellRefs.map(ref => tx.get(ref)));
    const allowanceSnap = allowanceRef ? await tx.get(allowanceRef) : null;

    const nowMs = Date.now();
    const taken = [];
    snaps.forEach((s, i) => {
      if (s.exists() && cellBlocks(s.data(), nowMs)) taken.push(nights[i]);
    });
    if (taken.length) throw new RoomUnavailableError(roomId, taken);

    // Throws before anything is written, so a refused visitor leaves no trace.
    const allowance = allowanceRef ? nextAllowance(allowanceSnap, nowMs) : null;

    tx.set(bookingRef, booking);
    if (allowanceRef) tx.set(allowanceRef, allowance);
    cellRefs.forEach((ref, i) => tx.set(ref, bornConfirmed
      ? {
          roomId, date: nights[i], bookingId: bookingRef.id,
          status: 'confirmed', holdExpiresAt: null, rate: ratePerNight,
        }
      : {
          roomId, date: nights[i], bookingId: bookingRef.id,
          status: 'held', holdExpiresAt,
        }));

    // A booking taken at the desk is a staff action, so it goes on the record.
    // A guest's own web booking does not: the booking already names who made it.
    if (bornConfirmed) {
      tx.set(doc(collection(db, 'audit')), auditEntry(uid, 'walk_in', {
        bookingId: bookingRef.id, roomId, summary: describeBooking(booking),
      }));
    }
  });

  return {
    id: bookingRef.id, ...booking,
    holdExpiresAt: holdExpiresAt ? holdExpiresAt.toDate() : null,
  };
}

/* ── Paying before arrival ────────────────────────────────────────
   The two hours exist so a room is not held all day for someone who never
   turns up. A guest who has actually paid should not be held to that, so
   there is one way out: pay the lodge's till on your own phone, tell the
   system you have paid and quote the reference from the message, and
   reception checks their own phone and decides.

   Nothing here talks to a bank. A claim is a claim — it never confirms a
   booking, never writes money onto one, and never holds a room outright.
   Only reception's confirmation does that. What a claim DOES do is restart
   the hold, so a guest who really has paid does not lose the room while
   somebody is looking at their phone. A guest could keep claiming to keep
   restarting it, but every claim rings the desk loudly, so that is noisy
   rather than silent — and reception can decline the booking outright.   */

export class PaymentClaimError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaymentClaimError';
  }
}

/** The guest says they have paid. Restarts the hold; confirms nothing. */
export async function claimPayment(db, bookingId, details, uid, holdMinutes = HOLD_MINUTES) {
  const { reference, payerName = '', payerPhone = '' } = details || {};
  const ref = String(reference ?? '').trim().toUpperCase();
  if (ref.length < 4 || ref.length > 40) {
    throw new PaymentClaimError('the reference from your payment message is needed');
  }
  const name  = String(payerName ?? '').trim().slice(0, 100);
  const phone = String(payerPhone ?? '').replace(/[\s()-]/g, '').slice(0, 20);
  if (!uid) throw new PaymentClaimError('a signed-in uid is required');

  return runTransaction(db, async tx => {
    const bRef  = doc(db, 'bookings', bookingId);
    const bSnap = await tx.get(bRef);
    if (!bSnap.exists()) throw new PaymentClaimError(`no such booking ${bookingId}`);

    const b = bSnap.data();
    if (b.createdBy !== uid)    throw new PaymentClaimError('that booking was made on another device');
    if (b.status !== 'pending') throw new PaymentClaimError(`booking is already ${b.status}`);

    const nights   = nightsBetween(b.checkIn, b.checkOut);
    const cellRefs = nights.map(d => doc(db, 'nights', nightKey(b.roomId, d)));
    const snaps    = await Promise.all(cellRefs.map(r => tx.get(r)));

    // If the hold lapsed and the room has gone, say so now rather than take a
    // payment claim for a room the guest cannot have.
    const lost = [];
    snaps.forEach((s, i) => {
      if (!s.exists() || s.data().bookingId !== bookingId) lost.push(nights[i]);
    });
    if (lost.length) throw new RoomUnavailableError(b.roomId, lost);

    const until = Timestamp.fromMillis(Date.now() + holdMinutes * 60_000);

    tx.update(bRef, {
      holdExpiresAt: until,
      payment: {
        status: 'claimed',
        reference: ref,
        payerName: name,
        payerPhone: phone,
        amount: b.total,              // always the full stay; never a figure the guest picked
        claimedAt: serverTimestamp(),
      },
    });
    // The ledger has to move with it, or the room goes back on sale while
    // reception is still checking the phone.
    cellRefs.forEach((r, i) => tx.set(r, { ...snaps[i].data(), holdExpiresAt: until }));

    return { id: bookingId, reference: ref, amount: b.total };
  });
}

/**
 * Reception looked at their phone and the money is not there. The booking
 * stays pending and its hold keeps running: the guest can pay, or correct the
 * reference and claim again, or lose the room the ordinary way.
 */
export async function rejectPayment(db, bookingId, reason, staffUid) {
  return runTransaction(db, async tx => {
    const bRef  = doc(db, 'bookings', bookingId);
    const bSnap = await tx.get(bRef);
    if (!bSnap.exists()) throw new BookingError(`no such booking ${bookingId}`);

    const b = bSnap.data();
    if (b.payment?.status !== 'claimed') throw new BookingError('there is no payment waiting to be checked');

    tx.update(bRef, {
      payment: { ...b.payment, status: 'not_found', note: String(reason || '').slice(0, 300), reviewedBy: staffUid },
      updatedAt: serverTimestamp(),
      updatedBy: staffUid,
    });
    tx.set(doc(collection(db, 'audit')), auditEntry(staffUid, 'payment_rejected', {
      bookingId, roomId: b.roomId,
      summary: `${describeBooking(b)} · ref ${b.payment.reference} not found · ${reason || '(no note)'}`,
      before: { payment: 'claimed' }, after: { payment: 'not_found' },
    }));

    return { id: bookingId, ...b, payment: { ...b.payment, status: 'not_found' } };
  });
}

/* ── Front-desk status moves ──────────────────────────────────── */

const STATUS_ACTION = { checked_in: 'check_in', checked_out: 'check_out' };

async function moveStatus(db, bookingId, allowedFrom, to, staffUid) {
  return runTransaction(db, async tx => {
    const bRef  = doc(db, 'bookings', bookingId);
    const bSnap = await tx.get(bRef);
    if (!bSnap.exists()) throw new BookingError(`no such booking ${bookingId}`);

    const b = bSnap.data();
    if (!allowedFrom.includes(b.status)) {
      throw new BookingError(`booking is ${b.status}, expected ${allowedFrom.join(' or ')}`);
    }

    tx.update(bRef, { status: to, updatedAt: serverTimestamp(), updatedBy: staffUid });
    tx.set(doc(collection(db, 'audit')), auditEntry(staffUid, STATUS_ACTION[to], {
      bookingId, roomId: b.roomId, summary: describeBooking(b),
      before: { status: b.status }, after: { status: to },
    }));
    return { id: bookingId, ...b, status: to };
  });
}

/** Guest has arrived and taken the key. */
export function checkInGuest(db, bookingId, staffUid) {
  return moveStatus(db, bookingId, ['confirmed'], 'checked_in', staffUid);
}

/** Guest has left. The nights stay spent — they are history, not availability. */
export function checkOutGuest(db, bookingId, staffUid) {
  return moveStatus(db, bookingId, ['checked_in'], 'checked_out', staffUid);
}

/* ── Lifecycle (staff) ────────────────────────────────────────── */

/**
 * Reception confirms. The hold becomes permanent and the agreed rate is
 * stamped onto each night — cells only ever carry money a human approved,
 * which is what makes revenue-by-date trustworthy.
 */
export async function confirmBooking(db, bookingId, staffUid, { paymentReceived = false } = {}) {
  return runTransaction(db, async tx => {
    const bRef  = doc(db, 'bookings', bookingId);
    const bSnap = await tx.get(bRef);
    if (!bSnap.exists()) throw new BookingError(`no such booking ${bookingId}`);

    const b = bSnap.data();
    if (b.status !== 'pending') throw new BookingError(`booking is already ${b.status}`);

    const nights   = nightsBetween(b.checkIn, b.checkOut);
    const cellRefs = nights.map(d => doc(db, 'nights', nightKey(b.roomId, d)));
    const snaps    = await Promise.all(cellRefs.map(ref => tx.get(ref)));

    // If a hold lapsed and someone else took the night, confirming would
    // silently double-book. Refuse instead.
    const lost = [];
    snaps.forEach((s, i) => {
      if (!s.exists() || s.data().bookingId !== bookingId) lost.push(nights[i]);
    });
    if (lost.length) throw new RoomUnavailableError(b.roomId, lost);

    // Confirming on the back of a payment is the same act — the room stops
    // being a hold and becomes theirs — so it goes through here rather than
    // down a second path that could drift out of step with this one.
    if (paymentReceived && b.payment?.status !== 'claimed') {
      throw new BookingError('there is no payment waiting to be checked');
    }

    tx.update(bRef, {
      status: 'confirmed',
      holdExpiresAt: null,
      updatedAt: serverTimestamp(),
      updatedBy: staffUid,
      ...(paymentReceived
        ? { payment: { ...b.payment, status: 'received', reviewedBy: staffUid } }
        : {}),
    });

    cellRefs.forEach((ref, i) => tx.set(ref, {
      roomId: b.roomId,
      date: nights[i],
      bookingId,
      status: 'confirmed',
      holdExpiresAt: null,
      rate: b.ratePerNight,
    }));

    tx.set(doc(collection(db, 'audit')), paymentReceived
      ? auditEntry(staffUid, 'payment_confirmed', {
          bookingId, roomId: b.roomId,
          summary: `${describeBooking(b)} · paid, ref ${b.payment.reference}`,
          before: { status: b.status, payment: 'claimed' },
          after:  { status: 'confirmed', payment: 'received' },
        })
      : auditEntry(staffUid, 'confirm', {
          bookingId, roomId: b.roomId, summary: describeBooking(b),
          before: { status: b.status }, after: { status: 'confirmed' },
        }));

    return { id: bookingId, ...b, status: 'confirmed' };
  });
}

/** How much longer reception's exception holds a room, unless they say otherwise. */
export const EXTENSION_MINUTES = 120;

/** The longest a single exception may run, so a slip of the finger cannot take
 *  a room off sale for a week. Reception can always extend again. */
export const MAX_EXTENSION_MINUTES = 24 * 60;

/**
 * Reception makes an exception to the two hours: a guest who has phoned to say
 * they are on their way keeps the room.
 *
 * The booking and every night it still holds move together in one transaction,
 * so the ledger and the booking can never disagree about when the hold runs
 * out — and the extension goes on the record with the name of whoever granted
 * it. The new expiry runs from now, not from the old one: "hold it two more
 * hours" means two hours from the moment it is asked for.
 */
export async function extendHold(db, bookingId, minutes = EXTENSION_MINUTES, staffUid) {
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins < 1 || mins > MAX_EXTENSION_MINUTES) {
    throw new BookingError(`an extension must be between 1 minute and ${MAX_EXTENSION_MINUTES / 60} hours`);
  }

  return runTransaction(db, async tx => {
    const bRef  = doc(db, 'bookings', bookingId);
    const bSnap = await tx.get(bRef);
    if (!bSnap.exists()) throw new BookingError(`no such booking ${bookingId}`);

    const b = bSnap.data();
    // A confirmed booking has no expiry to extend, and a cancelled one has no
    // room. Only a hold that is still waiting can be held longer.
    if (b.status !== 'pending') throw new BookingError(`booking is ${b.status}, only a hold can be extended`);

    const nights   = nightsBetween(b.checkIn, b.checkOut);
    const cellRefs = nights.map(d => doc(db, 'nights', nightKey(b.roomId, d)));
    const snaps    = await Promise.all(cellRefs.map(ref => tx.get(ref)));

    // If this hold already lapsed and someone else took a night, there is
    // nothing left to extend: promising it would double-book the room.
    const lost = [];
    snaps.forEach((s, i) => {
      if (!s.exists() || s.data().bookingId !== bookingId) lost.push(nights[i]);
    });
    if (lost.length) throw new RoomUnavailableError(b.roomId, lost);

    const until = Timestamp.fromMillis(Date.now() + mins * 60_000);

    tx.update(bRef, { holdExpiresAt: until, updatedAt: serverTimestamp(), updatedBy: staffUid });
    cellRefs.forEach((ref, i) => tx.set(ref, { ...snaps[i].data(), holdExpiresAt: until }));

    tx.set(doc(collection(db, 'audit')), auditEntry(staffUid, 'extend_hold', {
      bookingId, roomId: b.roomId,
      summary: `${describeBooking(b)} · held ${mins} minutes longer by the desk`,
      before: { holdExpiresAt: b.holdExpiresAt ?? null },
      after:  { holdExpiresAt: until },
    }));

    return { id: bookingId, ...b, holdExpiresAt: until.toDate() };
  });
}

/**
 * Cancel and hand the nights back. The booking is never deleted — it becomes
 * a cancelled row with a reason and an author.
 */
export async function cancelBooking(db, bookingId, reason, staffUid) {
  return runTransaction(db, async tx => {
    const bRef  = doc(db, 'bookings', bookingId);
    const bSnap = await tx.get(bRef);
    if (!bSnap.exists()) throw new BookingError(`no such booking ${bookingId}`);

    const b = bSnap.data();
    const nights   = nightsBetween(b.checkIn, b.checkOut);
    const cellRefs = nights.map(d => doc(db, 'nights', nightKey(b.roomId, d)));
    const snaps    = await Promise.all(cellRefs.map(ref => tx.get(ref)));

    tx.update(bRef, {
      status: 'cancelled',
      cancelReason: reason || '',
      holdExpiresAt: null,
      updatedAt: serverTimestamp(),
      updatedBy: staffUid,
    });

    // Only release nights this booking still owns — a lapsed hold may already
    // have been reclaimed by someone else, and that claim must stand.
    snaps.forEach((s, i) => {
      if (s.exists() && s.data().bookingId === bookingId) tx.delete(cellRefs[i]);
    });

    tx.set(doc(collection(db, 'audit')), auditEntry(staffUid, 'cancel', {
      bookingId, roomId: b.roomId,
      summary: `${describeBooking(b)} · reason: ${reason || '(none given)'}`,
      before: { status: b.status }, after: { status: 'cancelled' },
    }));

    return { id: bookingId, released: nights.length };
  });
}

/**
 * Tidy up holds nobody acted on. Lapsed cells already stop blocking on their
 * own, so this is housekeeping rather than correctness — it exists so the
 * reception list is not cluttered with requests that quietly died.
 */
export async function sweepExpiredHolds(db, staffUid, nowMs = Date.now()) {
  const snap = await getDocs(query(
    collection(db, 'bookings'),
    where('status', '==', 'pending'),
    where('holdExpiresAt', '<', Timestamp.fromMillis(nowMs)),
  ));

  const swept = [];
  for (const d of snap.docs) {
    await runTransaction(db, async tx => {
      const bRef  = doc(db, 'bookings', d.id);
      const bSnap = await tx.get(bRef);
      if (!bSnap.exists() || bSnap.data().status !== 'pending') return;

      const b        = bSnap.data();
      const nights   = nightsBetween(b.checkIn, b.checkOut);
      const cellRefs = nights.map(n => doc(db, 'nights', nightKey(b.roomId, n)));
      const cells    = await Promise.all(cellRefs.map(ref => tx.get(ref)));

      tx.update(bRef, {
        status: 'expired',
        holdExpiresAt: null,
        updatedAt: serverTimestamp(),
        updatedBy: staffUid,
      });
      cells.forEach((s, i) => {
        if (s.exists() && s.data().bookingId === d.id) tx.delete(cellRefs[i]);
      });
      tx.set(doc(collection(db, 'audit')), auditEntry(staffUid, 'expire', {
        bookingId: d.id, roomId: b.roomId,
        summary: `${describeBooking(b)} · hold lapsed unanswered`,
      }));
    });
    swept.push(d.id);
  }
  return swept;
}
