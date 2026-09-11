// tests/indexes.test.js
//
// Static check: every Firestore query in the app that needs a composite index
// has one declared in firestore.indexes.json.
//
// This CANNOT be checked against the emulator. It builds composite indexes on
// demand, so a missing declaration passes every local run and the whole suite,
// then fails in production with `failed-precondition: The query requires an
// index` — for whoever happens to hit that query.
//
// The query list is DERIVED from the source, never hand-written: a hand-kept
// list stays the same length while the code grows, and quietly stops covering
// it. A small floor of known pairings is kept in case the extractor ever stops
// seeing one, and the suite fails if it suddenly finds fewer queries than it
// should.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT     = fileURLToPath(new URL('..', import.meta.url));
const EQUALITY = new Set(['==', 'in', 'array-contains', 'array-contains-any']);

/** Queries the app is known to run. If the extractor misses one, this still holds the line. */
const FLOOR = [
  { file: '(floor) sweepExpiredHolds', line: 0, collection: 'bookings',
    wheres: [{ field: 'status', op: '==' }, { field: 'holdExpiresAt', op: '<' }], orders: [] },
];

/** Raise this when the app gains queries; never lower it to make a red run pass. */
const MIN_APP_QUERIES = 4;

function jsFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : jsFiles(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

/** The text between a '(' and its matching ')'. */
function balanced(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(openIdx + 1, i);
  }
  return src.slice(openIdx + 1);
}

function extractQueries(src, file = '<src>') {
  const found = [];
  for (const m of src.matchAll(/\bquery\s*\(/g)) {
    const body = balanced(src, m.index + m[0].length - 1);
    const coll = body.match(/collection\(\s*[\w.]+\s*,\s*['"]([\w-]+)['"]/);
    found.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      collection: coll ? coll[1] : null,
      wheres: [...body.matchAll(/where\(\s*['"]([\w.]+)['"]\s*,\s*['"]([^'"]+)['"]/g)]
        .map(w => ({ field: w[1], op: w[2] })),
      orders: [...body.matchAll(/orderBy\(\s*['"]([\w.]+)['"]/g)].map(o => o[1]),
    });
  }
  return found;
}

function needsComposite(q) {
  const fields = new Set([...q.wheres.map(w => w.field), ...q.orders]);
  if (fields.size <= 1) return false;                        // one field: built automatically
  const hasRange = q.wheres.some(w => !EQUALITY.has(w.op));
  return hasRange || q.orders.length > 0;                    // equality-only can merge indexes
}

/** Equality fields first (any order), then the range / order-by fields in order. */
function satisfied(q, indexes) {
  const eq   = new Set(q.wheres.filter(w => EQUALITY.has(w.op)).map(w => w.field));
  const tail = [...new Set([
    ...q.wheres.filter(w => !EQUALITY.has(w.op)).map(w => w.field),
    ...q.orders,
  ])];
  return indexes.some(ix => {
    if (ix.collectionGroup !== q.collection) return false;
    const f = ix.fields.map(x => x.fieldPath);
    return f.slice(0, eq.size).every(x => eq.has(x))
        && tail.every((t, i) => f[eq.size + i] === t);
  });
}

const describeQuery = q =>
  `${q.file}:${q.line}  ${q.collection}(${[
    ...q.wheres.map(w => `${w.field} ${w.op}`),
    ...q.orders.map(o => `orderBy ${o}`),
  ].join(', ')})`;

const indexes = JSON.parse(readFileSync(join(ROOT, 'firestore.indexes.json'), 'utf8')).indexes;
const queries = jsFiles(join(ROOT, 'js'))
  .flatMap(f => extractQueries(readFileSync(f, 'utf8'), relative(ROOT, f).replace(/\\/g, '/')));

describe('the extractor', () => {
  test('reads a multi-line query with nested calls in its arguments', () => {
    const [q] = extractQueries(`const s = await getDocs(query(
      collection(state.db, 'bookings'),
      where('status', '==', 'pending'),
      where('holdExpiresAt', '<', Timestamp.fromMillis(nowMs)),
      orderBy('holdExpiresAt'),
    ));`);
    assert.equal(q.collection, 'bookings');
    assert.deepEqual(q.wheres, [
      { field: 'status', op: '==' }, { field: 'holdExpiresAt', op: '<' }]);
    assert.deepEqual(q.orders, ['holdExpiresAt']);
  });

  test('knows which shapes need a composite index', () => {
    const q = (wheres, orders = []) => ({ wheres, orders });
    assert.equal(needsComposite(q([{ field: 'date', op: '>=' }, { field: 'date', op: '<=' }])), false,
      'a range on one field needs nothing declared');
    assert.equal(needsComposite(q([{ field: 'a', op: '==' }, { field: 'b', op: '==' }])), false,
      'equality on several fields can merge single-field indexes');
    assert.equal(needsComposite(q([{ field: 'status', op: '==' }, { field: 'holdExpiresAt', op: '<' }])), true);
    assert.equal(needsComposite(q([{ field: 'storeId', op: 'in' }], ['name'])), true,
      'the shape that broke staff sessions in the other project');
  });

  test('an index with the fields in the wrong order does not count', () => {
    const q = { collection: 'bookings', wheres: [
      { field: 'status', op: '==' }, { field: 'holdExpiresAt', op: '<' }], orders: [] };
    const wrong = [{ collectionGroup: 'bookings', fields: [
      { fieldPath: 'holdExpiresAt' }, { fieldPath: 'status' }] }];
    const right = [{ collectionGroup: 'bookings', fields: [
      { fieldPath: 'status' }, { fieldPath: 'holdExpiresAt' }] }];
    assert.equal(satisfied(q, wrong), false);
    assert.equal(satisfied(q, right), true);
  });
});

describe('declared indexes', () => {
  test('the extractor still sees the app’s queries — fails closed if it goes blind', () => {
    assert.ok(queries.length >= MIN_APP_QUERIES,
      `expected at least ${MIN_APP_QUERIES} queries in js/, found ${queries.length}:\n` +
      queries.map(describeQuery).join('\n'));
  });

  test('every query names a collection this check can resolve', () => {
    assert.deepEqual(
      queries.filter(q => !q.collection).map(describeQuery), [],
      'write the collection inline in query(), or add the pairing to FLOOR');
  });

  test('every query that needs a composite index has one declared', () => {
    const missing = [...queries, ...FLOOR]
      .filter(q => needsComposite(q) && !satisfied(q, indexes))
      .map(describeQuery);
    assert.deepEqual(missing, [],
      'declare these in firestore.indexes.json, then: firebase deploy --only firestore:indexes');
  });
});
