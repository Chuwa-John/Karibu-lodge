// tests/no-queued-writes.test.js
//
// Every write in the app must go through a Firestore transaction.
//
// A transaction FAILS when the device is offline. setDoc, updateDoc, addDoc,
// deleteDoc and write batches do not: they queue the write and send it whenever
// the connection returns — possibly hours later, after someone else has taken
// the room. For a lodge that is exactly how a room gets sold twice. (The retail
// app on this machine deliberately accepts queued offline sales and flags
// oversells; a bed has no backorder, so this app must not.)
//
// Derived from the source on disk: any direct write call anywhere in js/ fails
// this test, and so does the checker going blind.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const QUEUEING = ['setDoc', 'updateDoc', 'addDoc', 'deleteDoc', 'writeBatch'];

/** Raise when the app gains transactions; never lower it to pass a red run. */
const MIN_TRANSACTIONS = 6;

function jsFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : jsFiles(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function findQueueingWrites(src, file = '<src>') {
  const code = stripComments(src);
  const hits = [];
  const call = new RegExp(`\\b(${QUEUEING.join('|')})\\s*\\(`, 'g');
  for (const m of code.matchAll(call)) {
    hits.push(`${file}: calls ${m[1]}()`);
  }
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]firebase\/firestore['"]/g)) {
    for (const name of m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0])) {
      if (QUEUEING.includes(name)) hits.push(`${file}: imports ${name}`);
    }
  }
  return hits;
}

const files = jsFiles(join(ROOT, 'js')).map(f => ({
  name: relative(ROOT, f).replace(/\\/g, '/'),
  src: readFileSync(f, 'utf8'),
}));

describe('the checker', () => {
  test('catches a queued write, imported or called', () => {
    const hits = findQueueingWrites(
      `import { doc, updateDoc } from 'firebase/firestore';\nawait updateDoc(doc(db, 'rooms/r'), { rate: 1 });`);
    assert.equal(hits.length, 2);
  });

  test('allows writes made inside a transaction, and ignores comments', () => {
    const hits = findQueueingWrites(`
      // never call updateDoc(ref) here
      /* setDoc(x) is banned */
      await runTransaction(db, async tx => { tx.set(ref, {}); tx.update(ref, {}); tx.delete(ref); });`);
    assert.deepEqual(hits, []);
  });
});

describe('the app', () => {
  test('still has its transactions — the checker has not gone blind', () => {
    const count = files.reduce((n, f) => n + (stripComments(f.src).match(/\brunTransaction\s*\(/g) || []).length, 0);
    assert.ok(count >= MIN_TRANSACTIONS, `expected at least ${MIN_TRANSACTIONS} runTransaction calls in js/, found ${count}`);
  });

  test('never writes outside a transaction', () => {
    const hits = files.flatMap(f => findQueueingWrites(f.src, f.name));
    assert.deepEqual(hits, [],
      'use runTransaction and tx.set / tx.update / tx.delete — a queued write can sell a room twice');
  });
});
