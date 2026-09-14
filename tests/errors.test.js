// tests/errors.test.js — what people are told when something fails. Pure.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { explainError } from '../js/lib/errors.js';

const fbError = (code, message) => Object.assign(new Error(message), { code });

describe('explainError', () => {
  test('no connection, however Firebase phrases it', () => {
    for (const err of [
      fbError('unavailable', 'Could not reach Cloud Firestore backend.'),
      new Error('Failed to get document because the client is offline.'),
    ]) {
      assert.match(explainError(err, { online: true }), /^No connection\./);
    }
  });

  test('the browser saying it is offline wins over whatever the error says', () => {
    assert.match(explainError(fbError('internal', 'boom'), { online: false }), /^No connection\./);
  });

  test('never promises nothing changed — a commit can be cut off halfway', () => {
    assert.match(explainError(fbError('unavailable', 'x'), { online: true }), /check whether the change went through/);
  });

  test('a timeout says the same: check first', () => {
    assert.match(explainError(fbError('deadline-exceeded', 'x'), { online: true }), /check whether the change went through/i);
  });

  test('permission and missing-index failures are named plainly', () => {
    assert.equal(explainError(fbError('permission-denied', 'Missing or insufficient permissions.'), { online: true }),
      'This account is not allowed to do that.');
    assert.match(explainError(fbError('failed-precondition', 'The query requires an index.'), { online: true }),
      /missing an index/);
    assert.equal(explainError(fbError('failed-precondition', 'booking is already confirmed'), { online: true }),
      'booking is already confirmed', 'a precondition that is not about an index keeps its own words');
  });

  test('the app’s own messages pass through untouched', () => {
    assert.equal(explainError(new Error('guest phone is not a valid number'), { online: true }),
      'guest phone is not a valid number');
  });

  test('odd inputs still produce a sentence', () => {
    assert.equal(explainError('plain text', { online: true }), 'plain text');
    assert.match(explainError(null, { online: true }), /Something went wrong/);
    assert.match(explainError({}, { online: true }), /Something went wrong/);
  });
});
