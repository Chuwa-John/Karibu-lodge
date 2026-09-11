#!/usr/bin/env node
// scripts/set-role.js
//
// Grants a staff role. Roles live in the Auth token as a custom claim so the
// security rules can check them without an extra Firestore read.
//
//   node scripts/set-role.js reception@karibu.co.tz reception
//   node scripts/set-role.js owner@karibu.co.tz admin
//
// Against the emulator by default; FIRESTORE_TARGET=live for the real project.
// The user must sign out and back in for a new claim to reach their token.

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const [email, role, name] = process.argv.slice(2);
const ROLES = ['reception', 'admin', 'none'];

if (!email || !ROLES.includes(role)) {
  console.error('usage: node scripts/set-role.js <email> <reception|admin|none> [display name]');
  console.error('       "none" removes staff access.');
  process.exit(1);
}

const TARGET = process.env.FIRESTORE_TARGET === 'live' ? 'live' : 'emulator';
if (TARGET === 'emulator') {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9098';
  process.env.FIRESTORE_EMULATOR_HOST     ||= '127.0.0.1:8081';
  console.log(`→ emulator auth at ${process.env.FIREBASE_AUTH_EMULATOR_HOST}`);
} else if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('✖ FIRESTORE_TARGET=live needs GOOGLE_APPLICATION_CREDENTIALS');
  process.exit(1);
}

const projectId = process.env.GCLOUD_PROJECT || 'demo-karibu';
initializeApp(TARGET === 'live' ? { credential: applicationDefault() } : { projectId });

const auth = getAuth();
let user;
try {
  user = await auth.getUserByEmail(email);
} catch {
  console.error(`✖ no auth user for ${email} — create the sign-in first, then set the role`);
  process.exit(1);
}

if (role === 'none') {
  // Remove the claim, and refuse them any new sign-in token. A token they
  // already hold stays valid until it expires — at most an hour — because the
  // rules read the role from the token. That hour is the honest limit here.
  await auth.setCustomUserClaims(user.uid, null);
  await auth.revokeRefreshTokens(user.uid);
  await getFirestore().collection('staff').doc(user.uid).set({
    email, role: 'none', active: false, updatedAt: new Date(),
  }, { merge: true });
  console.log(`✓ ${email} no longer has staff access  (uid ${user.uid})`);
  console.log('  Their current sign-in stops working within the hour, and they cannot get a new one.');
  process.exit(0);
}

await auth.setCustomUserClaims(user.uid, { role });
await getFirestore().collection('staff').doc(user.uid).set({
  email, role, name: name || email.split('@')[0], active: true, updatedAt: new Date(),
}, { merge: true });

console.log(`✓ ${email} is now ${role}  (uid ${user.uid})`);
console.log('  They must sign out and back in before the new role takes effect.');
process.exit(0);
