// js/lib/errors.js
//
// Turns a failure into words reception and guests can act on.
//
// Every write in this app is a Firestore transaction, and a transaction does
// not queue while offline — it fails. So "no connection" almost always means
// the change did not happen. But a connection that drops during the commit
// itself can leave it unknown, so the wording asks people to check rather than
// promising that nothing changed.

const NO_CONNECTION =
  'No connection. When it is back, check whether the change went through before trying again.';

export function explainError(err, { online } = {}) {
  const isOnline = online ?? (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  const code    = String(err?.code || '');
  const message = String(err?.message || (typeof err === 'string' ? err : '') || '');

  if (!isOnline || code === 'unavailable' || /client is offline/i.test(message)) {
    return NO_CONNECTION;
  }
  if (code === 'deadline-exceeded') {
    return 'The connection timed out. Check whether the change went through before trying again.';
  }
  if (code === 'permission-denied') {
    return 'This account is not allowed to do that.';
  }
  if (code === 'failed-precondition' && /index/i.test(message)) {
    return 'The database is missing an index this screen needs. Tell whoever looks after the system.';
  }
  return message || 'Something went wrong. Please try again.';
}
