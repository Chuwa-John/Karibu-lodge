// js/lib/env.js
//
// Which Firebase to talk to. Localhost talks to the emulator, everything else
// talks to the real project.
//
// ── TO GO LIVE ──────────────────────────────────────────────────
// Fill in LIVE_CONFIG below from the Firebase console:
//   Project settings → General → Your apps → Web app → SDK setup → Config
// Nothing else in the codebase needs to change.

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
  apiKey:            'REPLACE_ME',
  authDomain:        'REPLACE_ME.firebaseapp.com',
  projectId:         'REPLACE_ME',
  storageBucket:     'REPLACE_ME.appspot.com',
  messagingSenderId: 'REPLACE_ME',
  appId:             'REPLACE_ME',
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
