// js/lib/rooms.js
//
// The physical inventory. Six rooms, fixed. This file is the seed source and
// the offline fallback for the room picker — Firestore is the live source of
// truth, because the admin can change a rate without a deploy.
//
// Rate is in TSH and VAT-inclusive, matching what the site has always
// advertised ("per night · taxes included").

export const ROOMS = [
  { id: 'room-1', number: 1, type: 'deluxe',   rate: 30000, active: true },
  { id: 'room-2', number: 2, type: 'standard', rate: 20000, active: true },
  { id: 'room-3', number: 3, type: 'standard', rate: 20000, active: true },
  { id: 'room-4', number: 4, type: 'deluxe',   rate: 30000, active: true },
  { id: 'room-5', number: 5, type: 'standard', rate: 20000, active: true },
  { id: 'room-6', number: 6, type: 'deluxe',   rate: 30000, active: true },
];

export const ROOM_TYPES = {
  standard: {
    label: 'Standard Room',
    blurb: 'Economy Comfort',
    amenities: ['Comfortable Bed', 'Ceiling Fan', 'Private Toilet', 'Secure Door Lock'],
  },
  deluxe: {
    label: 'Deluxe Room',
    blurb: 'Premium Comfort',
    amenities: ['Comfortable Bed', 'Ceiling Fan', 'Air Conditioning',
                'Flat-Screen TV', 'Private Toilet', 'Secure Door Lock'],
  },
};

export function roomById(id)      { return ROOMS.find(r => r.id === id) || null; }
export function roomsOfType(type) { return ROOMS.filter(r => r.type === type); }
