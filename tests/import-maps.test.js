// tests/import-maps.test.js
//
// The browser resolves `import ... from 'firebase/firestore'` only through the
// import map in each HTML page. A module added to the code but missing from a
// page's map does not fail loudly in development — it fails in the browser, at
// runtime, for that page only. Derived from the source: every bare firebase/*
// specifier used anywhere in js/ must be mapped by both pages, all pinned to the
// same version as the SDK the tests run against.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldUseAppCheck, APP_CHECK_SITE_KEY } from '../js/lib/env.js';

const ROOT  = fileURLToPath(new URL('..', import.meta.url));
const PAGES = ['index.html', 'staff.html'];

function jsFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : jsFiles(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

function importMapOf(html) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]).imports : null;
}

const used = new Set(jsFiles(join(ROOT, 'js')).flatMap(f =>
  [...readFileSync(f, 'utf8').matchAll(/(?:from\s*|import\(\s*)['"](firebase\/[\w-]+)['"]/g)].map(m => m[1])));

const sdkVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules/firebase/package.json'), 'utf8')).version;

describe('import maps', () => {
  test('the checker still finds the Firebase modules the app uses', () => {
    for (const expected of ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/app-check']) {
      assert.ok(used.has(expected), `${expected} is no longer imported anywhere — was it removed on purpose?`);
    }
  });

  for (const page of PAGES) {
    test(`${page} maps every firebase/* module the code imports`, () => {
      const map = importMapOf(readFileSync(join(ROOT, page), 'utf8'));
      assert.ok(map, `${page} has no import map`);
      const missing = [...used].filter(spec => !map[spec]);
      assert.deepEqual(missing, [], `${page} would fail at runtime importing these`);
    });

    test(`${page} pins every Firebase module to the SDK version the tests use (${sdkVersion})`, () => {
      const map = importMapOf(readFileSync(join(ROOT, page), 'utf8'));
      const wrong = Object.entries(map)
        .filter(([spec]) => spec.startsWith('firebase/'))
        .filter(([, url]) => !url.includes(`/firebasejs/${sdkVersion}/`));
      assert.deepEqual(wrong, []);
    });
  }
});

describe('App Check switch', () => {
  test('off until a site key exists, and never against the emulator', () => {
    assert.equal(shouldUseAppCheck({ useEmulator: false, siteKey: '' }), false);
    assert.equal(shouldUseAppCheck({ useEmulator: true,  siteKey: 'key' }), false);
    assert.equal(shouldUseAppCheck({ useEmulator: false, siteKey: '  ' }), false);
    assert.equal(shouldUseAppCheck({ useEmulator: false, siteKey: 'key' }), true);
  });

  test('ships switched off — enforcement is turned on deliberately, after the dashboard shows it working', () => {
    assert.equal(APP_CHECK_SITE_KEY, '');
  });
});
