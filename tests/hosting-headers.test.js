// tests/hosting-headers.test.js — the production hosting config, vercel.json.
//
// The site is served by Vercel (https://karibu-lodge.vercel.app). firebase.json's
// hosting section only drives the local emulator, which applies no headers at
// all — so vercel.json is the one place production behaviour is set, and this
// checks it statically.
//
// Cache-Control: the site is plain ES modules with no version stamps on import
// URLs. If a browser may reuse a cached module without asking, a change can
// leave a page running new code against an old module (measured locally
// 2026-09-11: staff.js fetched fresh, lib/alerts.js reused from cache with no
// request). Vercel's own default for static files is exactly the value below;
// it is stated here so it cannot change silently.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE } from '../scripts/build-site.js';

const ROOT     = fileURLToPath(new URL('..', import.meta.url));
const vercel   = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const firebase = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'));

const REVALIDATE = 'public, max-age=0, must-revalidate';

/** Vercel `source` patterns are path-to-regexp; the ones used here are plain
 *  regular expressions, so anchoring them is an exact reading. */
function headersFor(path) {
  const out = {};
  for (const rule of vercel.headers || []) {
    if (new RegExp(`^${rule.source}$`).test(path)) {
      for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
    }
  }
  return out;
}

describe('how Vercel builds the site', () => {
  test('no framework, no npm install, an explicit build and output folder', () => {
    // With a package.json and no build, Vercel's static builder throws, and its
    // default output folder ("public") does not exist in this repo.
    assert.equal(vercel.framework, null);
    assert.equal(vercel.installCommand, '', 'the build needs nothing from npm');
    assert.equal(vercel.buildCommand, 'node scripts/build-site.js');
    assert.equal(vercel.outputDirectory, 'dist');
  });

  test('/staff reaches the reception console, which the build publishes', () => {
    const rule = (vercel.rewrites || []).find(r => r.source === '/staff');
    assert.equal(rule?.destination, '/staff.html');
    assert.ok(SITE.includes('staff.html'));
  });
});

describe('headers on every response', () => {
  const paths = [
    '/', '/staff', '/index.html', '/staff.html',
    '/js/main.js', '/js/staff.js', '/js/lib/alerts.js', '/js/lib/firebase.js',
    '/css/base.css', '/css/responsive.css', '/assets/images/hero.jpg',
  ];

  for (const path of paths) {
    test(`${path}: revalidated every time, with the security headers`, () => {
      const h = headersFor(path);
      assert.equal(h['cache-control'], REVALIDATE);
      assert.equal(h['x-content-type-options'], 'nosniff');
      assert.equal(h['x-frame-options'], 'DENY');
      assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin');
    });
  }
});

describe('one source of truth', () => {
  test('firebase.json no longer pretends to set production headers', () => {
    assert.equal(firebase.hosting?.headers, undefined,
      'headers belong in vercel.json; the emulator ignores them and production is not Firebase Hosting');
  });
});
