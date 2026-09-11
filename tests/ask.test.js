// tests/ask.test.js — the in-page confirm and text prompts.
//
// Runs without a browser or the emulator. The dialog is a small fake that
// behaves like <dialog> where it matters: showModal refuses when already open,
// close(value) sets returnValue, and the `close` event is a QUEUED task, never
// synchronous. It can also be told never to deliver `close` at all — which is
// what the Claude browser pane did on 2026-09-11, and what the first version of
// ask.js could not survive.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { askConfirm, askText } from '../js/lib/ask.js';

function fakeEl() {
  return {
    textContent: '', value: '', placeholder: '', hidden: false, disabled: false,
    focused: false, focus() { this.focused = true; },
    onclick: null, oninput: null, onkeydown: null,
    classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); } },
  };
}

class FakeDialog extends EventTarget {
  constructor(overrides = {}, { deliverEvents = true } = {}) {
    super();
    this.open = false;
    this.returnValue = '';
    this.deliverEvents = deliverEvents;
    this.onkeydown = null;
    this.listeners = { close: 0, cancel: 0 };
    this.parts = {
      title: fakeEl(), message: fakeEl(), field: fakeEl(), label: fakeEl(),
      input: fakeEl(), ok: fakeEl(), cancel: fakeEl(), ...overrides,
    };
  }
  querySelector(sel) {
    const m = sel.match(/data-ask="(\w+)"/);
    return m ? (this.parts[m[1]] ?? null) : null;
  }
  addEventListener(type, fn) { if (type in this.listeners) this.listeners[type]++; super.addEventListener(type, fn); }
  removeEventListener(type, fn) { if (type in this.listeners) this.listeners[type]--; super.removeEventListener(type, fn); }
  showModal() {
    if (this.open) throw new DOMException('already open', 'InvalidStateError');
    this.open = true;
  }
  /** Like the real element: the close event is queued, not dispatched inline. */
  close(value) {
    if (!this.open) return;
    this.open = false;
    if (value !== undefined) this.returnValue = value;
    if (this.deliverEvents) setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  }
  /** Keydown reaches the dialog first; unhandled, the browser cancels and closes. */
  pressEscape() {
    if (!this.open) return;
    let prevented = false;
    this.onkeydown?.({ key: 'Escape', preventDefault() { prevented = true; } });
    if (prevented || !this.open) return;
    if (this.deliverEvents) this.dispatchEvent(new Event('cancel'));
    this.close();
  }
}

/** The failure mode is a promise that never settles, which would HANG the
 *  suite rather than fail it — so every answer is raced against a timer. */
function settle(promise, ms = 1000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('the answer never settled')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

describe('askConfirm', () => {
  test('OK answers yes', async () => {
    const d = new FakeDialog();
    const answer = askConfirm('Decline?', { dialog: d });
    d.parts.ok.onclick();
    assert.equal(await settle(answer), true);
  });

  test('Cancel answers no', async () => {
    const d = new FakeDialog();
    const answer = askConfirm('Decline?', { dialog: d });
    d.parts.cancel.onclick();
    assert.equal(await settle(answer), false);
  });

  test('Escape answers no', async () => {
    const d = new FakeDialog();
    const answer = askConfirm('Decline?', { dialog: d });
    d.pressEscape();
    assert.equal(await settle(answer), false);
    assert.equal(d.open, false);
  });

  test('something else closing the dialog answers by its returnValue', async () => {
    const d = new FakeDialog();
    const agreed = askConfirm('Decline?', { dialog: d });
    d.close('ok');
    assert.equal(await settle(agreed), true);

    const refused = askConfirm('Decline?', { dialog: d });
    d.close();
    assert.equal(await settle(refused), false);
  });

  test('a stale "ok" from the last question cannot answer this one', async () => {
    const d = new FakeDialog();
    const first = askConfirm('First?', { dialog: d });
    d.parts.ok.onclick();
    assert.equal(await settle(first), true);
    await tick();
    assert.equal(d.returnValue, 'ok', 'the stale value really is left behind');

    const second = askConfirm('Second?', { dialog: d });
    d.close();                                  // a close with no value of its own
    assert.equal(await settle(second), false);
  });

  test('it answers exactly once, even when the close event arrives afterwards', async () => {
    const d = new FakeDialog();
    const answer = askConfirm('Decline?', { dialog: d });
    d.parts.ok.onclick();
    d.parts.cancel.onclick?.();                 // already detached: must not flip the answer
    assert.equal(await settle(answer), true);
    await tick();                               // the queued close event lands now
    assert.equal(await answer, true);
  });

  test('no dialog on the page answers no rather than assuming yes', async () => {
    assert.equal(await settle(askConfirm('Decline?')), false);
    assert.equal(await settle(askConfirm('Decline?', { dialog: new FakeDialog({ ok: null }) })), false);
  });

  test('a dialog already asking something answers no and leaves that question alone', async () => {
    const d = new FakeDialog();
    const first  = askConfirm('Decline Amina?', { dialog: d });
    const second = askConfirm('Decline Juma?', { dialog: d });

    assert.equal(await settle(second), false);
    assert.equal(d.parts.message.textContent, 'Decline Amina?', 'the open question was not rewritten');

    d.parts.ok.onclick();
    assert.equal(await settle(first), true);
  });

  test('every handler is detached once answered', async () => {
    const d = new FakeDialog();
    const answer = askConfirm('Decline?', { dialog: d });
    d.parts.ok.onclick();
    await settle(answer);

    assert.deepEqual(d.listeners, { close: 0, cancel: 0 });
    assert.equal(d.onkeydown, null);
    assert.equal(d.parts.ok.onclick, null);
    assert.equal(d.parts.cancel.onclick, null);
  });

  test('focus lands on Cancel, so a stray Enter agrees to nothing', async () => {
    const d = new FakeDialog();
    const answer = askConfirm('Decline?', { dialog: d });
    assert.equal(d.parts.cancel.focused, true);
    assert.equal(d.parts.ok.focused, false);
    d.parts.cancel.onclick();
    await settle(answer);
  });

  test('text goes in as textContent, never as markup', async () => {
    const d = new FakeDialog();
    const hostile = '<img src=x onerror=alert(1)>';
    const answer = askConfirm(hostile, { dialog: d, title: hostile });
    assert.equal(d.parts.message.textContent, hostile);
    assert.equal(d.parts.message.innerHTML, undefined);
    assert.equal(d.parts.title.innerHTML, undefined);
    d.parts.cancel.onclick();
    await settle(answer);
  });
});

describe('when the browser never delivers close or cancel', () => {
  // The regression: this is what the Claude browser pane did, and waiting on
  // the event there left Decline awaiting forever.
  const silent = () => new FakeDialog({}, { deliverEvents: false });

  test('OK still answers yes', async () => {
    const d = silent();
    const answer = askConfirm('Decline?', { dialog: d });
    d.parts.ok.onclick();
    assert.equal(await settle(answer), true);
  });

  test('Cancel still answers no', async () => {
    const d = silent();
    const answer = askConfirm('Decline?', { dialog: d });
    d.parts.cancel.onclick();
    assert.equal(await settle(answer), false);
  });

  test('Escape still answers no', async () => {
    const d = silent();
    const answer = askConfirm('Decline?', { dialog: d });
    d.pressEscape();
    assert.equal(await settle(answer), false);
  });

  test('a typed reason still comes back, by click and by Enter', async () => {
    const d = silent();
    const byClick = askText('Reason?', { dialog: d, required: true });
    d.parts.input.value = 'guest changed plans';
    d.parts.input.oninput();
    d.parts.ok.onclick();
    assert.equal(await settle(byClick), 'guest changed plans');

    const byEnter = askText('Reason?', { dialog: d, required: true });
    d.parts.input.value = 'double booked';
    d.parts.input.oninput();
    d.parts.input.onkeydown({ key: 'Enter', preventDefault() {} });
    assert.equal(await settle(byEnter), 'double booked');
  });

  test('the dialog is shut, so the next question can open', async () => {
    const d = silent();
    const first = askConfirm('First?', { dialog: d });
    d.parts.ok.onclick();
    await settle(first);
    assert.equal(d.open, false);

    const second = askConfirm('Second?', { dialog: d });
    assert.equal(d.open, true, 'a stuck-open dialog would refuse every later question');
    d.parts.cancel.onclick();
    assert.equal(await settle(second), false);
  });
});

describe('askText', () => {
  test('returns what was typed', async () => {
    const d = new FakeDialog();
    const answer = askText('Reason?', { dialog: d });
    d.parts.input.value = 'guest changed plans';
    d.parts.input.oninput();
    d.parts.ok.onclick();
    assert.equal(await settle(answer), 'guest changed plans');
  });

  test('Cancel and Escape both return null', async () => {
    const d = new FakeDialog();
    const a = askText('Reason?', { dialog: d });
    d.parts.input.value = 'typed then abandoned';
    d.parts.cancel.onclick();
    assert.equal(await settle(a), null);

    const b = askText('Reason?', { dialog: d });
    d.pressEscape();
    assert.equal(await settle(b), null);
  });

  test('the box is cleared on close, so nothing carries into the next question', async () => {
    const d = new FakeDialog();
    const answer = askText('Reason?', { dialog: d });
    d.parts.input.value = 'private note';
    d.parts.ok.onclick();
    await settle(answer);
    assert.equal(d.parts.input.value, '');
  });

  test('a required answer cannot be submitted empty — not by click, not by Enter', async () => {
    const d = new FakeDialog();
    const enter = { key: 'Enter', preventDefault() {} };
    const answer = askText('Reason?', { dialog: d, required: true });

    assert.equal(d.parts.ok.disabled, true);
    d.parts.input.value = '   ';
    d.parts.input.oninput();
    assert.equal(d.parts.ok.disabled, true, 'whitespace is not a reason');

    d.parts.ok.onclick();
    assert.equal(d.open, true, 'a click on a disabled OK must not submit');
    d.parts.input.onkeydown(enter);
    assert.equal(d.open, true, 'Enter must not submit an empty required answer');

    d.parts.input.value = 'room double booked';
    d.parts.input.oninput();
    assert.equal(d.parts.ok.disabled, false);
    d.parts.input.onkeydown(enter);
    assert.equal(await settle(answer), 'room double booked');
  });

  test('a required prompt does not leave OK disabled for the next confirm', async () => {
    const d = new FakeDialog();
    const text = askText('Reason?', { dialog: d, required: true });
    d.parts.cancel.onclick();
    await settle(text);

    const confirm = askConfirm('Sure?', { dialog: d });
    assert.equal(d.parts.ok.disabled, false);
    d.parts.ok.onclick();
    assert.equal(await settle(confirm), true);
  });

  test('focus lands in the box', async () => {
    const d = new FakeDialog();
    const answer = askText('Reason?', { dialog: d });
    assert.equal(d.parts.input.focused, true);
    d.parts.cancel.onclick();
    await settle(answer);
  });

  test('no dialog returns null', async () => {
    assert.equal(await settle(askText('Reason?')), null);
  });
});
