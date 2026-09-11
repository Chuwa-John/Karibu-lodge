// tests/hosting-headers.test.js
//
// The site is plain ES modules: no build step, no version stamp on any import
// URL. If a browser is allowed to reuse a cached module without asking, a deploy
// can leave a page running new code against an old module.
//
// Measured 2026-09-11: with no Cache-Control header, the browser fetched
// js/staff.js fresh but served js/lib/alerts.js from its cache without making a
// request at all (transferSize 0). The page ran a fix in one file against the
// unfixed other, and a browser check passed for the wrong reason. Worse cases
// throw outright — new code calling a function the old module does not export.
//
// So every HTML, JS and CSS response must carry `Cache-Control: no-cache`:
// the browser revalidates every time, and an unchanged file costs only a 304.
// Checked statically against firebase.json, the file Hosting actually obeys.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfg  = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'));

/** Enough of Hosting's glob syntax for the patterns this project uses:
 *  `**`, `*` and `@(a|b)`. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (glob.startsWith('**/', i)) { re += '(?:.*/)?'; i += 2; }
    else if (glob.startsWith('**', i)) { re += '.*'; i += 1; }
    else if (ch === '*') re += '[^/]*';
    else if (glob.startsWith('@(', i)) {
      const end = glob.indexOf(')', i);
      re += '(?:' + glob.slice(i + 2, end).split('|').map(s => s.replace(/[.+^${}()[\]\\]/g, '\\$&')).join('|') + ')';
      i = end;
    } else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function headersFor(path) {
  const bare = path.replace(/^\//, '');
  const out = {};
  for (const rule of cfg.hosting.headers || []) {
    const src = rule.source;
    const hit = src === path || (src !== '/' && globToRegExp(src.replace(/^\//, '')).test(bare));
    if (hit) for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}

describe('the glob reader', () => {
  test('matches the way Hosting does for the patterns in use', () => {
    const re = globToRegExp('**/*.@(html|js|css)');
    for (const yes of ['index.html', 'js/staff.js', 'js/lib/alerts.js', 'css/staff.css']) assert.ok(re.test(yes), yes);
    for (const no of ['assets/images/hero.jpg', 'js/staff.jsx', 'firebase.json']) assert.ok(!re.test(no), no);
  });
});

describe('every page, script and stylesheet is revalidated', () => {
  const mustRevalidate = [
    '/', '/staff',                                  // served by rewrite, no extension
    '/index.html', '/staff.html',
    '/js/main.js', '/js/staff.js', '/js/admin-ui.js', '/js/guest-booking.js',
    '/js/lib/alerts.js', '/js/lib/availability.js', '/js/lib/env.js',
    '/css/base.css', '/css/responsive.css', '/css/staff.css',
  ];

  for (const path of mustRevalidate) {
    test(`${path} is sent with Cache-Control: no-cache`, () => {
      assert.equal(headersFor(path)['cache-control'], 'no-cache');
    });
  }

  test('the security headers still apply alongside it', () => {
    const h = headersFor('/js/staff.js');
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['x-frame-options'], 'DENY');
  });
});
