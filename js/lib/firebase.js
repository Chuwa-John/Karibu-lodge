// js/lib/firebase.js
//
// One Firebase app for the whole site, created on first use.
//
// Imports use bare specifiers ('firebase/app'), which the browser resolves
// through the import map in each HTML file and Node resolves from
// node_modules. That is what lets the same modules run in the browser and
// under the test suite without a build step.

import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, signInAnonymously,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';

import { FIREBASE_CONFIG, USE_EMULATOR, EMULATOR_PORTS, IS_CONFIGURED } from './env.js';

let app, db, auth;

export function initFirebase() {
  if (app) return { app, db, auth };

  if (!IS_CONFIGURED) {
    throw new Error(
      'Firebase is not configured yet — fill in LIVE_CONFIG in js/lib/env.js');
  }

  app  = getApps()[0] || initializeApp(FIREBASE_CONFIG);
  db   = getFirestore(app);
  auth = getAuth(app);

  if (USE_EMULATOR) {
    connectFirestoreEmulator(db, '127.0.0.1', EMULATOR_PORTS.firestore);
    connectAuthEmulator(auth, `http://127.0.0.1:${EMULATOR_PORTS.auth}`,
      { disableWarnings: true });
  }

  return { app, db, auth };
}

/** Guests never make an account — an anonymous uid is only there so the
 *  security rules can tell one booking session from another. */
export async function signInGuest() {
  const { auth: a } = initFirebase();
  if (a.currentUser) return a.currentUser;
  const cred = await signInAnonymously(a);
  return cred.user;
}

export async function signInStaff(email, password) {
  const { auth: a } = initFirebase();
  const cred = await signInWithEmailAndPassword(a, email, password);
  return cred.user;
}

export async function signOutStaff() {
  const { auth: a } = initFirebase();
  await signOut(a);
}

/**
 * Resolves the signed-in user and their role. The role lives in a custom
 * claim on the token, so reading it costs nothing extra — but a role granted
 * after the token was issued only appears once the token refreshes, which is
 * why set-role.js tells staff to sign out and back in.
 */
export function watchStaffAuth(onChange) {
  const { auth: a } = initFirebase();
  return onAuthStateChanged(a, async user => {
    if (!user) return onChange(null);
    const token = await user.getIdTokenResult();
    onChange({ user, role: token.claims.role || null });
  });
}
