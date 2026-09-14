// js/lib/env.js
//
// Which Firebase to talk to. Localhost talks to the emulator, everything else
// talks to the real project.
//
// ── LIVE PROJECT ────────────────────────────────────────────────
// karibu-lodge-booking, created 2026-09-14. These values are not secret: they
// ship inside the page and identify the project, nothing more. What keeps the
// data safe is firestore.rules, and later App Check.
//
// Still to do in the Firebase console before the site can take a booking:
//   1. Authentication → Sign-in method → Anonymous → Enable.
//      Guests sign in anonymously to hold a room; without this every booking
//      fails at the sign-in step.
//   2. Firestore Database → Create database (this also switches the API on).
// Then deploy the rules and indexes.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export const USE_EMULATOR =
  typeof location !== 'undefined' && LOCAL_HOSTS.includes(location.hostname);

/** Ports match firebase.json. Deliberately NOT the Firebase defaults — the
 *  other project on this machine uses 8080/9099 and must not be disturbed. */
export const EMULATOR_PORTS = { firestore: 8081, auth: 9098 };

/** The emulator accepts any config for a `demo-` project and never reaches
 *  Google, so local development needs no real credentials at all. */
const EMULATOR_CONFIG = {
  projectId: 'demo-karibu',
  apiKey: 'demo-api-key',
  authDomain: 'localhost',
};

const LIVE_CONFIG = {
  apiKey:            'AIzaSyC-_YbdE79uc97lWK5WI0RZRfWztoAB3zA',
  authDomain:        'karibu-lodge-booking.firebaseapp.com',
  projectId:         'karibu-lodge-booking',
  storageBucket:     'karibu-lodge-booking.firebasestorage.app',
  messagingSenderId: '23482327666',
  appId:             '1:23482327666:web:f4d62329645af6cb8898eb',
};

/** Firebase App Check (reCAPTCHA Enterprise). Leave empty until a site key
 *  exists for the live domain. With a key, every request from the site carries
 *  proof it came from this web page, so a script calling the database directly
 *  can be refused. Turn ENFORCEMENT on in the Firebase console only after its
 *  App Check dashboard shows the site's requests arriving verified: enforcing
 *  first would lock out the real site too. Never used against the emulator. */
export const APP_CHECK_SITE_KEY = '';

export function shouldUseAppCheck({ useEmulator, siteKey }) {
  return !useEmulator && String(siteKey || '').trim() !== '';
}

export const FIREBASE_CONFIG = USE_EMULATOR ? EMULATOR_CONFIG : LIVE_CONFIG;

export const IS_CONFIGURED =
  USE_EMULATOR || !Object.values(LIVE_CONFIG).some(v => String(v).includes('REPLACE_ME'));
