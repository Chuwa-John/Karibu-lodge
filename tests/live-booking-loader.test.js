// tests/live-booking-loader.test.js
//
// The switch between live booking and the WhatsApp form (initLiveBooking in
// js/booking.js), run under Node — where js/lib/env.js is in exactly the state
// production is in until someone fills in LIVE_CONFIG: not configured.
//
// A browser cannot reach that branch from localhost, which always talks to the
// emulator. Loading the site from another hostname does not work either: the
// Claude browser pane blocks that origin's CSS and scripts, so nothing runs and
// the WhatsApp form shows merely because it is the default — which looks like
// a pass and proves nothing.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initLiveBooking } from '../js/booking.js';
import { IS_CONFIGURED } from '../js/lib/env.js';

const GATE_MESSAGE = 'Error: Firebase is not configured yet';

let page;
let warnings;
let originalWarn;

function installPage() {
  const nodes = {
    'wa-booking':   { hidden: false },   // as served: the WhatsApp form is the default
    'live-loading': { hidden: true },
    'live-booking': { hidden: true },
  };
  const doc = new EventTarget();
  doc.getElementById = id => nodes[id] ?? null;
  globalThis.document = doc;
  globalThis.window = new EventTarget();
  return nodes;
}

const showPage = name =>
  window.dispatchEvent(new CustomEvent('pagechange', { detail: name }));

/** The loader awaits dynamic imports; let them finish. */
const settle = () => new Promise(r => setTimeout(r, 200));

beforeEach(() => {
  page = installPage();
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
});

afterEach(() => {
  console.warn = originalWarn;
  delete globalThis.document;
  delete globalThis.window;
});

describe('live booking loader', () => {
  test('this suite really is running with Firebase unconfigured', () => {
    assert.equal(IS_CONFIGURED, false,
      'LIVE_CONFIG must still hold REPLACE_ME here, as production does today');
  });

  test('unconfigured: the guest keeps the WhatsApp form, and Firebase is never fetched', async () => {
    initLiveBooking({ liveBooking: true, whatsapp: '255700000000' });
    showPage('booking');
    await settle();

    assert.equal(page['wa-booking'].hidden, false, 'the WhatsApp form is back on screen');
    assert.equal(page['live-loading'].hidden, true, 'no spinner left spinning');
    assert.equal(page['live-booking'].hidden, true);

    // The gate throws this exact message BEFORE importing guest-booking.js.
    // initFirebase throws a longer one, so an exact match proves it stopped at
    // the gate — i.e. the Firebase SDK was never requested.
    assert.ok(warnings.some(w => w.endsWith(GATE_MESSAGE)),
      `expected to stop at the configuration check; warnings were: ${warnings.join(' | ') || '(none)'}`);
  });

  test('the kill switch loads nothing and leaves the page exactly as served', async () => {
    initLiveBooking({ liveBooking: false, whatsapp: '255700000000' });
    showPage('booking');
    await settle();

    assert.equal(page['wa-booking'].hidden, false);
    assert.equal(page['live-loading'].hidden, true);
    assert.equal(page['live-booking'].hidden, true);
    assert.deepEqual(warnings, [], 'it never even tried');
  });

  test('opening any other page does not start it', async () => {
    initLiveBooking({ liveBooking: true, whatsapp: '255700000000' });
    showPage('rooms');
    showPage('contact');
    await settle();

    assert.equal(page['wa-booking'].hidden, false);
    assert.equal(page['live-loading'].hidden, true);
    assert.deepEqual(warnings, []);
  });

  test('opening the booking page twice starts it once', async () => {
    initLiveBooking({ liveBooking: true, whatsapp: '255700000000' });
    showPage('booking');
    showPage('booking');   // the router really does fire twice on a hash change
    await settle();
    assert.equal(warnings.filter(w => w.endsWith(GATE_MESSAGE)).length, 1);
  });

  test('missing markup leaves the page alone rather than throwing', () => {
    document.getElementById = () => null;
    assert.doesNotThrow(() => initLiveBooking({ liveBooking: true }));
  });
});
