// tests/css-cascade.test.js
//
// A media query adds no specificity. A breakpoint rule only takes effect if it
// comes AFTER every ordinary rule setting the same property on the same
// selector — later in the same file, or in a stylesheet linked later on the page.
//
// This broke silently for four months. Splitting the single stylesheet into
// files (917e3ba, 2026-05-02) put every breakpoint rule at the end of base.css,
// which the page loads FIRST, so on a phone none of them applied. Nothing
// errored and every desktop screen looked right; on a phone the booking form sat
// off-screen to the right, the nav links overflowed and the hamburger never
// appeared.
//
// Derived from the HTML and CSS on disk, so a new stylesheet or rule is covered
// without anybody having to remember to list it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT  = fileURLToPath(new URL('..', import.meta.url));
const PAGES = [
  { page: 'index.html', minSheets: 4 },
  { page: 'staff.html', minSheets: 1 },
];

function stylesheetsOf(html) {
  return [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="(css\/[^"]+)"/g)].map(m => m[1]);
}

/** Flat list of style rules, in document order, remembering any media query. */
function parseCss(src, file, fileIndex) {
  const text  = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let order = 0;

  const walk = (chunk, media) => {
    let k = 0;
    while (k < chunk.length) {
      const open = chunk.indexOf('{', k);
      if (open === -1) break;

      let depth = 0, close = chunk.length;
      for (let j = open; j < chunk.length; j++) {
        if (chunk[j] === '{') depth++;
        else if (chunk[j] === '}' && --depth === 0) { close = j; break; }
      }

      const prelude = chunk.slice(k, open).trim();
      const body    = chunk.slice(open + 1, close);

      if (prelude.startsWith('@media')) {
        walk(body, prelude.replace(/\s+/g, ' '));
      } else if (prelude && !prelude.startsWith('@')) {          // skip @keyframes etc.
        const props = new Map();
        for (const decl of body.split(';')) {
          const colon = decl.indexOf(':');
          if (colon === -1) continue;
          const prop = decl.slice(0, colon).trim().toLowerCase();
          if (prop) props.set(prop, /!important/i.test(decl.slice(colon + 1)));
        }
        const at = order++;
        for (const sel of prelude.split(',')) {
          rules.push({ file, fileIndex, order: at, selector: sel.trim().replace(/\s+/g, ' '), media, props });
        }
      }
      k = close + 1;
    }
  };

  walk(text, null);
  return rules;
}

/** Breakpoint declarations that a later ordinary rule silently beats. */
function overridden(rules) {
  const found = [];
  for (const bp of rules.filter(r => r.media)) {
    for (const [prop, important] of bp.props) {
      if (important) continue;
      const winner = rules.find(r =>
        !r.media && r.selector === bp.selector && r.props.has(prop) &&
        (r.fileIndex > bp.fileIndex || (r.fileIndex === bp.fileIndex && r.order > bp.order)));
      if (winner) {
        found.push(`${bp.file} ${bp.media} { ${bp.selector} { ${prop} } } is beaten by ${winner.file}`);
      }
    }
  }
  return found;
}

describe('the checker itself', () => {
  test('reads rules inside and outside media queries, with their properties', () => {
    const rules = parseCss(`
      /* a comment { with braces } */
      .a, .b { display: flex; color: red }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (max-width: 768px) { .a { display: none !important; } }
    `, 'x.css', 0);
    assert.deepEqual(rules.map(r => [r.selector, r.media]), [
      ['.a', null], ['.b', null], ['.a', '@media (max-width: 768px)'],
    ]);
    assert.equal(rules[2].props.get('display'), true, '!important is noticed');
  });

  test('flags a breakpoint rule that a later stylesheet overrides — the real bug', () => {
    const base   = parseCss('@media (max-width: 768px) { .hamburger { display: flex; } }', 'base.css', 0);
    const layout = parseCss('.hamburger { display: none; cursor: pointer; }', 'layout.css', 1);
    assert.equal(overridden([...base, ...layout]).length, 1);
  });

  test('flags an override later in the same file', () => {
    const rules = parseCss('@media (max-width: 768px) { .a { display: none; } } .a { display: flex; }', 'x.css', 0);
    assert.equal(overridden(rules).length, 1);
  });

  test('a breakpoint rule that comes last is fine, and so is !important', () => {
    const early = parseCss('.a { display: flex; }', 'first.css', 0);
    const late  = parseCss('@media (max-width: 768px) { .a { display: none; } }', 'last.css', 1);
    assert.deepEqual(overridden([...early, ...late]), []);

    const imp  = parseCss('@media (max-width: 768px) { .a { height: 200px !important; } }', 'first.css', 0);
    const over = parseCss('.a { height: 400px; }', 'last.css', 1);
    assert.deepEqual(overridden([...imp, ...over]), []);
  });

  test('a later rule setting a different property is not an override', () => {
    const early = parseCss('@media (max-width: 768px) { .a { display: none; } }', 'first.css', 0);
    const late  = parseCss('.a { color: red; }', 'last.css', 1);
    assert.deepEqual(overridden([...early, ...late]), []);
  });
});

describe('breakpoint rules actually apply', () => {
  for (const { page, minSheets } of PAGES) {
    test(`${page}: no breakpoint rule is beaten by a rule loaded after it`, () => {
      const sheets = stylesheetsOf(readFileSync(join(ROOT, page), 'utf8'));
      assert.ok(sheets.length >= minSheets,
        `${page} links ${sheets.length} local stylesheet(s), expected at least ${minSheets} — has the markup changed?`);

      const rules = sheets.flatMap((f, i) => parseCss(readFileSync(join(ROOT, f), 'utf8'), f, i));
      assert.ok(rules.some(r => r.media),
        `${page}: found no breakpoint rules at all — the checker may have gone blind`);

      assert.deepEqual(overridden(rules), [],
        'breakpoint rules must come after the rules they override; see css/responsive.css');
    });
  }
});
