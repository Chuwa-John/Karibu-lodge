// tests/site-build.test.js — what Vercel will publish, built for real into a
// temporary folder.
//
// Two ways a deploy goes wrong without anyone noticing locally:
//   - something private is published (tests, scripts, the security rules), or
//   - a file the site needs is left out, so a page or module 404s in production.
// Both are checked from the built output itself, by following every local
// reference in the pages, scripts and styles.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildSite, SITE } from '../scripts/build-site.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let tmp, out;

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const isExternal = ref =>
  !ref || /^(https?:|\/\/|data:|mailto:|tel:|#|javascript:)/i.test(ref) || ref.includes('${');

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'karibu-site-'));
  out = buildSite(join(tmp, 'dist')).out;
});
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe('what is published', () => {
  test('exactly the site, and nothing private', () => {
    assert.deepEqual(readdirSync(out).sort(), [...SITE].sort());
    for (const secret of ['tests', 'scripts', 'node_modules', 'package.json', 'package-lock.json',
                          'firestore.rules', 'firestore.indexes.json', 'firebase.json', 'vercel.json', '.gitignore']) {
      assert.equal(existsSync(join(out, secret)), false, `${secret} must not be published`);
    }
  });

  test('every file is a byte-for-byte copy, and none is missing', () => {
    const built = walk(out).map(f => relative(out, f));
    const source = SITE.flatMap(entry => {
      const p = join(ROOT, entry);
      return statSync(p).isDirectory() ? walk(p).map(f => relative(ROOT, f)) : [entry];
    });
    assert.deepEqual(built.sort(), source.sort());
    for (const f of built) {
      assert.ok(readFileSync(join(out, f)).equals(readFileSync(join(ROOT, f))), `${f} differs from the repo`);
    }
  });
});

describe('everything the site asks for is there', () => {
  test('every local href and src in the pages resolves', () => {
    const missing = [];
    for (const page of ['index.html', 'staff.html']) {
      const html = readFileSync(join(out, page), 'utf8');
      for (const m of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
        const ref = m[1].split(/[?#]/)[0];
        if (isExternal(m[1]) || ref === '') continue;
        const target = ref.startsWith('/') ? join(out, ref) : join(out, dirname(page), ref);
        if (!existsSync(target)) missing.push(`${page} → ${m[1]}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  test('every relative import in every module resolves', () => {
    const missing = [];
    let seen = 0;
    for (const file of walk(join(out, 'js')).filter(f => f.endsWith('.js'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?:from\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        seen++;
        if (!existsSync(resolve(dirname(file), m[1]))) missing.push(`${relative(out, file)} → ${m[1]}`);
      }
    }
    assert.ok(seen >= 20, `only ${seen} relative imports found — has the checker gone blind?`);
    assert.deepEqual(missing, []);
  });

  test('every image the site config points at is published', () => {
    const config = readFileSync(join(out, 'js/config.js'), 'utf8');
    const images = [...config.matchAll(/["'](assets\/[^"']+)["']/g)].map(m => m[1]);
    assert.ok(images.length >= 5, 'the checker found no images in js/config.js');
    assert.deepEqual(images.filter(p => !existsSync(join(out, p))), []);
  });
});

describe('the build script itself', () => {
  test('uses Node built-ins only, so Vercel can skip npm install', () => {
    const src = readFileSync(join(ROOT, 'scripts/build-site.js'), 'utf8');
    const imports = [...src.matchAll(/from\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    assert.ok(imports.length > 0);
    assert.deepEqual(imports.filter(spec => !spec.startsWith('node:')), []);
  });

  test('refuses to wipe the repository', () => {
    assert.throws(() => buildSite(ROOT), /refusing to build/);
    assert.throws(() => buildSite(join(ROOT, '..')), /refusing to build/);
  });
});
