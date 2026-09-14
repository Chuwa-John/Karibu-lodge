// js/lib/audit.js
//
// The shape of an audit entry, in one place. Every staff action that changes a
// booking or a room writes one of these inside the SAME transaction as the
// change, so the record can never disagree with what happened: either both
// land, or neither does.
//
// The security rules require `actor` to be the signed-in user and `at` to be
// the server's clock, so an entry cannot be written in someone else's name or
// backdated. A guest's own web booking writes no entry — the booking already
// names who made it.

import { serverTimestamp } from 'firebase/firestore';

export const AUDIT_ACTIONS = [
  'walk_in', 'confirm', 'cancel', 'check_in', 'check_out', 'expire', 'room_update',
  'extend_hold', 'payment_confirmed', 'payment_rejected',
];

export const AUDIT_LABELS = {
  walk_in:     'Walk-in taken',
  confirm:     'Booking confirmed',
  cancel:      'Booking declined',
  check_in:    'Guest checked in',
  check_out:   'Guest checked out',
  expire:      'Lapsed hold cleared',
  room_update: 'Room changed',
  extend_hold: 'Hold extended',
  payment_confirmed: 'Payment confirmed',
  payment_rejected:  'Payment not found',
};

export function auditEntry(actor, action, { bookingId, roomId, summary = '', before, after } = {}) {
  if (!AUDIT_ACTIONS.includes(action)) throw new Error(`unknown audit action ${action}`);
  const entry = {
    actor,
    action,
    summary: String(summary).slice(0, 300),
    at: serverTimestamp(),
  };
  if (bookingId) entry.bookingId = bookingId;
  if (roomId)    entry.roomId = roomId;
  if (before)    entry.before = before;
  if (after)     entry.after = after;
  return entry;
}

export function describeBooking(b) {
  const total = Number(b.total || 0).toLocaleString('en-GB');
  return `${b.guestName} · Room ${b.roomNumber} · ${b.checkIn} → ${b.checkOut} · ${total} TSH`;
}
