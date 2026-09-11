// js/lib/ask.js
//
// In-page confirm and text prompts. Never window.confirm or window.prompt.
//
// A browser may decline to show a native dialog and answer on the user's
// behalf. Chrome offers "prevent this page from creating additional dialogs",
// and once that is ticked prompt() returns null without asking anybody — so a
// button gated on it does nothing at all, silently, until the browser restarts.
// These resolve the same shapes (a boolean, or a string / null) from a <dialog>
// the page owns and the browser cannot suppress.
//
// Rules pinned by tests/ask.test.js, which must survive any edit:
//   - Every way out answers, and none of them waits on the browser to deliver
//     an event. OK, Cancel, Enter and Escape resolve from their own handlers;
//     the dialog's `cancel` and `close` events are only a catch-all for
//     anything else that shuts it. Found 2026-09-11 in the Claude browser pane:
//     close() shut the dialog and set returnValue, but no `close` event ever
//     arrived — so the first version, which waited for it, left Decline
//     awaiting forever. The same silent no-op, reached by a different road.
//   - It answers exactly once, however many of those routes fire.
//   - returnValue is cleared before opening. It survives from the previous
//     question, so a catch-all close would otherwise read a stale "ok".
//   - No dialog, or one already showing another question, answers no.
//     Assuming yes would run an action nobody agreed to.
//   - Every handler is detached before resolving. The dialog is shared, so a
//     stale handler would answer a different question.
//   - Text is set with textContent. These strings carry guest names.

const UNAVAILABLE = Symbol('unavailable');

function findDialog(opts) {
  if (opts.dialog) return opts.dialog;
  if (typeof document === 'undefined') return null;
  return document.getElementById('askDialog');
}

function part(dialog, name) {
  return dialog.querySelector(`[data-ask="${name}"]`);
}

function open(dialog, opts, withInput) {
  return new Promise(resolve => {
    // Checked before touching anything: writing the title of a dialog that is
    // already open would rewrite the question someone is reading.
    if (dialog.open) return resolve(UNAVAILABLE);

    const el = {
      title:   part(dialog, 'title'),
      message: part(dialog, 'message'),
      field:   part(dialog, 'field'),
      label:   part(dialog, 'label'),
      input:   part(dialog, 'input'),
      ok:      part(dialog, 'ok'),
      cancel:  part(dialog, 'cancel'),
    };
    if (!el.ok || !el.cancel || (withInput && !el.input)) return resolve(UNAVAILABLE);

    if (el.title)   el.title.textContent   = opts.title || '';
    if (el.message) el.message.textContent = opts.message || '';
    el.ok.textContent     = opts.okLabel || 'OK';
    el.cancel.textContent = opts.cancelLabel || 'Cancel';
    el.ok.classList?.toggle('btn-danger', !!opts.danger);
    el.ok.classList?.toggle('btn-primary', !opts.danger);
    if (el.field) el.field.hidden = !withInput;

    let settled = false;

    const detach = () => {
      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('cancel', onCancel);
      dialog.onkeydown = null;
      el.ok.onclick = null;
      el.cancel.onclick = null;
      if (withInput) { el.input.oninput = null; el.input.onkeydown = null; }
    };

    // Every route to an answer comes through here, and only the first counts.
    const finish = agreed => {
      if (settled) return;
      settled = true;
      const value = withInput ? el.input.value : null;
      detach();                                   // before close(): no handler hears it
      if (withInput) el.input.value = '';         // nothing left for the next caller
      if (dialog.open) dialog.close(agreed ? 'ok' : 'cancel');
      resolve({ agreed, value });
    };

    const onCancel = () => finish(false);
    const onClose  = () => finish(dialog.returnValue === 'ok');

    if (withInput) {
      const required = !!opts.required;
      const refresh  = () => { el.ok.disabled = required && !el.input.value.trim(); };
      if (el.label) el.label.textContent = opts.label || '';
      el.input.value       = opts.value || '';
      el.input.placeholder = opts.placeholder || '';
      el.input.oninput     = refresh;
      el.input.onkeydown   = e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (!el.ok.disabled) finish(true);
      };
      refresh();
    } else {
      // A required text prompt may have left this disabled.
      el.ok.disabled = false;
    }

    el.ok.onclick     = () => { if (!el.ok.disabled) finish(true); };
    el.cancel.onclick = () => finish(false);
    dialog.onkeydown  = e => {
      if (e.key !== 'Escape') return;
      e.preventDefault();                         // answer here; don't wait for the browser
      finish(false);
    };

    dialog.returnValue = '';
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);

    try {
      dialog.showModal();
    } catch {
      detach();
      return resolve(UNAVAILABLE);
    }

    // Confirm: Cancel, so a stray Enter never agrees to anything.
    // Text: the box, so the answer can be typed straight away.
    (withInput ? el.input : el.cancel).focus?.();
  });
}

/** Resolves true only if the person pressed OK. */
export async function askConfirm(message, opts = {}) {
  const dialog = findDialog(opts);
  if (!dialog) return false;
  const r = await open(dialog, { ...opts, message }, false);
  return r !== UNAVAILABLE && r.agreed;
}

/** Resolves the typed text, or null if they backed out. Callers must treat
 *  null as "do nothing" — never as an empty answer. */
export async function askText(message, opts = {}) {
  const dialog = findDialog(opts);
  if (!dialog) return null;
  const r = await open(dialog, { ...opts, message }, true);
  if (r === UNAVAILABLE || !r.agreed) return null;
  return r.value;
}
