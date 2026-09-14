// tests/live-booking-loader.test.js
//
// The switch between live booking and the WhatsApp form (initLiveBooking in
// js/booking.js), run under Node.
//
// What matters is the promise the switch makes: if live booking cannot start
// for ANY reason — kill switch, unconfigured project, blocked CDN, no
// connection, markup that is not there — the guest is left looking at the
// WhatsApp form that was already on the page, with no spinner still turning.
//
// Until 2026-09-14 that was proved by running with LIVE_CONFIG unfilled, which
// is how production stood. Now the live project is configured, so the failure
// is staged a different way: the booking markup is absent, and mountLiveBooking
// gives up on that BEFORE it asks the network for anything. The same catch
// handles every other reason, so the guest ends up in the same place.
//
// Nothing here may touch the network. A test that quietly reads from the real
// project would be slow, flaky, and would depend on somebody else's internet.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initLiveBooking } from '../js/booking.js';
import { IS_CONFIGURED } from '../js/lib/env.js';

let page;
let warnings;
let originalWarn;

function installPage() {
  // Only the three ids the loader itself uses. Everything the booking form
  // needs is missing on purpose — that is what makes it give up early.
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

/** The loader awaits dynamic imports, and the Firebase SDK is a big one to
 *  pull in from disk the first time. Long enough that a slow machine does not
 *  report a pass before the work has happened. */
const settle = () => new Promise(r => setTimeout(r, 1500));

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
  test('the live project is configured — without this the site quietly serves WhatsApp only', () => {
    // The guard that used to assert the opposite. If LIVE_CONFIG is ever
    // blanked or half-filled, every guest silently loses live booking and
    // nothing on the page says why.
    assert.equal(IS_CONFIGURED, true,
      'js/lib/env.js has lost its LIVE_CONFIG: the live site would fall back to the WhatsApp form');
  });

  test('when live booking cannot start, the guest keeps the WhatsApp form', async () => {
    initLiveBooking({ liveBooking: true, whatsapp: '255700000000' });
    showPage('booking');
    await settle();

    assert.equal(page['wa-booking'].hidden, false, 'the WhatsApp form is back on screen');
    assert.equal(page['live-loading'].hidden, true, 'no spinner left spinning');
    assert.equal(page['live-booking'].hidden, true);
    assert.ok(warnings.length, 'the failure must be reported, not swallowed');
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
    assert.equal(warnings.length, 1, `tried more than once: ${warnings.join(' | ')}`);
  });

  test('missing markup leaves the page alone rather than throwing', () => {
    document.getElementById = () => null;
    assert.doesNotThrow(() => initLiveBooking({ liveBooking: true }));
  });
});
