#!/usr/bin/env node
// scripts/seed.js
//
// Seeds the six rooms. Safe to re-run: it merges, so a rate the admin has
// changed in the console is NOT clobbered unless you pass --force.
//
//   npm run seed                 -> emulator (default, safe)
//   npm run seed -- --force      -> emulator, overwrite rates back to defaults
//   FIRESTORE_TARGET=live npm run seed
//                                -> real project, needs GOOGLE_APPLICATION_CREDENTIALS
//
// Written on day one on purpose: an emulator wipe with no way back is a bad
// afternoon, and this is fifteen lines.

import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ROOMS, ROOM_TYPES } from '../js/lib/rooms.js';

const FORCE  = process.argv.includes('--force');
const TARGET = process.env.FIRESTORE_TARGET === 'live' ? 'live' : 'emulator';

if (TARGET === 'emulator') {
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8081';
  console.log(`→ emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`);
} else {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('✖ FIRESTORE_TARGET=live needs GOOGLE_APPLICATION_CREDENTIALS');
    process.exit(1);
  }
  console.log('→ LIVE project. Ctrl-C now if that is not what you meant.');
}

const projectId = process.env.GCLOUD_PROJECT || 'demo-karibu';
initializeApp(TARGET === 'live' ? { credential: applicationDefault() } : { projectId });

const db = getFirestore();

let created = 0, merged = 0;
for (const room of ROOMS) {
  const ref  = db.collection('rooms').doc(room.id);
  const snap = await ref.get();

  const doc = {
    ...room,
    label:     ROOM_TYPES[room.type].label,
    blurb:     ROOM_TYPES[room.type].blurb,
    amenities: ROOM_TYPES[room.type].amenities,
    updatedAt: new Date(),
  };

  if (!snap.exists) {
    await ref.set({ ...doc, createdAt: new Date() });
    created++;
    console.log(`  + ${room.id}  Room ${room.number}  ${room.type.padEnd(8)} ${room.rate.toLocaleString()} TSH`);
  } else if (FORCE) {
    await ref.set(doc, { merge: true });
    merged++;
    console.log(`  ~ ${room.id}  Room ${room.number}  rate reset to ${room.rate.toLocaleString()} TSH`);
  } else {
    const live = snap.data();
    const drift = live.rate !== room.rate ? `  (live rate ${live.rate?.toLocaleString()} kept — use --force to reset)` : '';
    console.log(`  = ${room.id}  Room ${room.number}  exists${drift}`);
  }
}

console.log(`\n${created} created, ${merged} updated, ${ROOMS.length - created - merged} left alone.`);
process.exit(0);
