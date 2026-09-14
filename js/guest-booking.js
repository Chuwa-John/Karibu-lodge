// js/guest-booking.js
//
// Live room booking on the public site: the guest picks dates, sees which of
// the six rooms are actually free, picks one, and it is held for them.
//
// Loaded on demand the first time the booking page opens (initLiveBooking in
// booking.js), so the rest of the site never downloads Firebase.
// mountLiveBooking throws if it cannot start — not configured, CDN blocked, no
// connection — and the caller shows the WhatsApp form instead. Once mounted,
// failures are explained to the guest here, with WhatsApp as the way through.

import { initFirebase, signInGuest } from './lib/firebase.js';
import {
  loadRooms, fetchAvailability, isRoomFree, createBooking, bookingReference,
  claimPayment, PaymentClaimError,
  RoomUnavailableError, BookingError, HoldLimitError,
} from './lib/availability.js';
import { today, addDays, countNights, fmtDate, MAX_NIGHTS } from './lib/dates.js';
import { ROOM_TYPES } from './lib/rooms.js';

/** How long to wait on a read before telling the guest. Deliberately NOT
 *  applied to the booking write — see the submit handler. */
const READ_TIMEOUT_MS = 8000;

const PERKS = {
  standard: 'Fan · private toilet',
  deluxe:   'AC · TV · private toilet',
};

const PHONE_RE = /^\+?[0-9]{9,15}$/;

const $      = id => document.getElementById(id);
const money  = n => Number(n || 0).toLocaleString();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const typeLabel = room => ROOM_TYPES[room.type]?.label || room.type;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * What a failed booking means for the guest. Only "taken" and "refused" are
 * certain that nothing was written. Anything else — a connection dropped
 * mid-commit — may or may not have landed, and must be described that way.
 */
function outcomeOf(err) {
  if (err instanceof RoomUnavailableError) return 'taken';
  if (err instanceof HoldLimitError) return 'limit';
  if (err instanceof BookingError) return 'refused';
  if (err?.code === 'permission-denied' || err?.code === 'invalid-argument') return 'refused';
  return 'unknown';
}

export async function mountLiveBooking({ CONFIG, preferredType = null }) {
  const { db } = initFirebase();                       // throws when not configured

  const el = {
    pick: $('lb-step-pick'), done: $('lb-done'),
    checkIn: $('lb-checkin'), checkOut: $('lb-checkout'),
    status: $('lb-status'), rooms: $('lb-rooms'),
    form: $('lb-form'), summary: $('lb-summary'),
    name: $('lb-name'), nameErr: $('lb-name-error'),
    phone: $('lb-phone'), phoneErr: $('lb-phone-error'),
    error: $('lb-error'), submit: $('lb-submit'),
  };
  const missing = Object.entries(el).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`live booking markup missing: ${missing.join(', ')}`);

  const rooms = (await withTimeout(loadRooms(db), READ_TIMEOUT_MS, 'loading rooms'))
    .filter(r => r.active !== false);
  if (!rooms.length) throw new Error('no bookable rooms');

  const state = {
    blocked: null,      // Map from fetchAvailability, or null while not known
    selected: null,     // roomId
    preferredType,
    token: 0,           // discards answers for dates the guest has since changed
    busy: false,
  };

  /* ── Dates ─────────────────────────────────────────────────── */

  const t = today();
  el.checkIn.min    = t;
  el.checkIn.value  = t;
  el.checkOut.min   = addDays(t, 1);
  el.checkOut.value = addDays(t, 1);

  function datesProblem() {
    const ci = el.checkIn.value, co = el.checkOut.value;
    if (!ci || !co)    return 'Choose your check-in and check-out dates.';
    if (ci < today())  return 'Check-in cannot be in the past.';
    if (co <= ci)      return 'Check-out must be after check-in.';
    try { countNights(ci, co); }
    catch { return `For stays longer than ${MAX_NIGHTS} nights, please message us on WhatsApp.`; }
    return null;
  }

  el.checkIn.addEventListener('change', () => {
    const ci = el.checkIn.value;
    if (ci) {
      el.checkOut.min = addDays(ci, 1);
      if (!el.checkOut.value || el.checkOut.value <= ci) el.checkOut.value = addDays(ci, 1);
    }
    refresh();
  });
  el.checkOut.addEventListener('change', refresh);

  /* ── Messages ──────────────────────────────────────────────── */

  const waUrl = text => `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(text)}`;

  function setStatus(text, { retry = false } = {}) {
    el.status.textContent = text;
    if (!retry) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lb-link';
    btn.textContent = 'Try again';
    btn.onclick = refresh;
    el.status.append(' ', btn);
  }

  function showError(text, link = null) {
    el.error.textContent = text;
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'btn btn-whatsapp lb-error-action';
      a.textContent = link.label;
      el.error.append(a);
    }
    el.error.hidden = false;
    el.error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideError() {
    el.error.hidden = true;
    el.error.textContent = '';
  }

  function fieldError(input, box, message) {
    input.classList.toggle('error', !!message);
    box.textContent = message;
    box.style.display = message ? 'block' : 'none';
  }

  /* ── Rooms ─────────────────────────────────────────────────── */

  async function refresh() {
    const mine = ++state.token;
    const problem = datesProblem();
    if (problem) {
      state.blocked = null;
      setStatus(problem);
      renderRooms();
      return;
    }

    const ci = el.checkIn.value, co = el.checkOut.value;
    setStatus('Checking which rooms are free…');
    el.rooms.setAttribute('aria-busy', 'true');
    try {
      const blocked = await withTimeout(
        fetchAvailability(db, ci, addDays(co, -1)), READ_TIMEOUT_MS, 'checking availability');
      if (mine !== state.token) return;
      state.blocked = blocked;
      const free = rooms.filter(r => isRoomFree(blocked, r.id, ci, co)).length;
      const stay = `${plural(countNights(ci, co), 'night')}, ${fmtDate(ci)} → ${fmtDate(co)}`;
      setStatus(free
        ? `${free} of ${rooms.length} rooms free for ${stay}.`
        : `Every room is booked for ${stay}. Try other dates, or message us on WhatsApp.`);
    } catch (err) {
      if (mine !== state.token) return;
      console.warn('[live booking] availability', err);
      state.blocked = null;
      setStatus('We could not check availability just now.', { retry: true });
    } finally {
      if (mine === state.token) el.rooms.removeAttribute('aria-busy');
    }
    renderRooms();
  }

  function roomIsFree(room) {
    return !!room
        && state.blocked !== null
        && !datesProblem()
        && isRoomFree(state.blocked, room.id, el.checkIn.value, el.checkOut.value);
  }

  function renderRooms() {
    if (state.selected && !roomIsFree(rooms.find(r => r.id === state.selected))) {
      state.selected = null;
    }

    const known = state.blocked !== null && !datesProblem();
    const rank  = r => (r.type === state.preferredType ? 0 : 1);

    el.rooms.innerHTML = [...rooms]
      .sort((a, b) => rank(a) - rank(b) || a.number - b.number)
      .map(r => {
        const free     = roomIsFree(r);
        const selected = state.selected === r.id;
        return `
          <button type="button" class="lb-room${selected ? ' is-selected' : ''}"
                  data-room-id="${esc(r.id)}" aria-pressed="${selected}" ${free ? '' : 'disabled'}>
            <span class="lb-room-no">Room ${esc(r.number)}</span>
            <span class="lb-room-type">${esc(typeLabel(r))} · ${esc(PERKS[r.type] || '')}</span>
            <span class="lb-room-price">${money(r.rate)} <small>TSH / night</small></span>
            <span class="lb-room-state">${!known ? '&nbsp;' : free ? 'Available' : 'Booked'}</span>
          </button>`;
      }).join('');

    renderForm();
  }

  function renderForm() {
    const room = rooms.find(r => r.id === state.selected);
    el.form.hidden = !room;
    if (!room) return;
    const ci = el.checkIn.value, co = el.checkOut.value;
    const n  = countNights(ci, co);
    el.summary.innerHTML =
      `<strong>Room ${esc(room.number)}</strong> · ${esc(typeLabel(room))}<br>` +
      `${fmtDate(ci)} → ${fmtDate(co)} · ${plural(n, 'night')}<br>` +
      `<span class="lb-total">${money(room.rate * n)} TSH</span> · pay on arrival`;
  }

  el.rooms.addEventListener('click', e => {
    const btn = e.target.closest('.lb-room');
    if (!btn || btn.disabled || state.busy) return;
    state.selected = btn.dataset.roomId;
    hideError();
    renderRooms();
    el.form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  /* ── Reserve ───────────────────────────────────────────────── */

  function setBusy(on) {
    state.busy = on;
    el.submit.disabled = on;
    el.submit.classList.toggle('loading', on);
    el.rooms.classList.toggle('is-busy', on);
    el.checkIn.disabled = on;
    el.checkOut.disabled = on;
  }

  el.form.addEventListener('submit', async e => {
    e.preventDefault();
    if (state.busy) return;
    hideError();

    const room = rooms.find(r => r.id === state.selected);
    const problem = datesProblem();
    if (problem || !room) { showError(problem || 'Choose a room first.'); return; }

    const name    = el.name.value.trim();
    const phone   = el.phone.value.replace(/[\s()-]/g, '');
    const nameOk  = name.length >= 2 && name.length <= 100;
    const phoneOk = PHONE_RE.test(phone);
    fieldError(el.name,  el.nameErr,  nameOk  ? '' : 'Please enter your full name.');
    fieldError(el.phone, el.phoneErr, phoneOk ? '' : 'Please enter a phone number we can call, e.g. 0712 345 678.');
    if (!nameOk || !phoneOk) return;

    const ci = el.checkIn.value, co = el.checkOut.value;
    const nights  = countNights(ci, co);
    const details =
      `Name: ${name}\nPhone: ${phone}\nRoom ${room.number} (${typeLabel(room)})\n` +
      `Check-in: ${fmtDate(ci)}\nCheck-out: ${fmtDate(co)}\n` +
      `Nights: ${nights}\nTotal: ${money(room.rate * nights)} TSH`;

    // Checked before anything is attempted, so this message can honestly say
    // the room has NOT been reserved: nothing has been sent.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showError('You seem to be offline, so your room has not been reserved. ' +
        'Check your connection and try again, or book with us on WhatsApp.',
        { label: '💬 Book on WhatsApp',
          href: waUrl(`Hello Karibu Lodge, I would like to book:\n${details}`) });
      return;
    }

    setBusy(true);
    let phase = 'connecting';
    try {
      const user = await withTimeout(signInGuest(), READ_TIMEOUT_MS, 'connecting');
      phase = 'booking';
      // No timeout on the write. If it lands after we stopped waiting, telling
      // the guest it failed would invite them to take the same room twice.
      const booking = await createBooking(db, {
        roomId: room.id, checkIn: ci, checkOut: co,
        guestName: name, guestPhone: phone, uid: user.uid, source: 'web',
      });
      showDone(booking, room);
    } catch (err) {
      console.warn(`[live booking] ${phase}`, err);
      const outcome = phase === 'connecting' ? 'refused' : outcomeOf(err);

      if (outcome === 'taken') {
        state.selected = null;
        showError(`Sorry — Room ${room.number} was just booked by someone else ` +
          `(${err.takenDates.map(fmtDate).join(', ')}). Please pick another room.`);
        await refresh();
      } else if (outcome === 'limit') {
        showError(`You have already held ${err.max} rooms in the last couple of hours, ` +
          'so this one has not been reserved. If you need more rooms than that, ' +
          'message us on WhatsApp and reception will arrange it for you.',
          { label: '💬 Message reception',
            href: waUrl(`Hello Karibu Lodge, I need more than ${err.max} rooms:\n${details}`) });
      } else if (outcome === 'refused') {
        showError('Your room has not been reserved — we could not complete the booking. ' +
          'Please try again, or book with us on WhatsApp.',
          { label: '💬 Book on WhatsApp',
            href: waUrl(`Hello Karibu Lodge, I would like to book:\n${details}`) });
      } else {
        showError('We could not confirm whether your booking went through. ' +
          'Please message us on WhatsApp before trying again, so we do not book you twice.',
          { label: '💬 Message reception',
            href: waUrl(`Hello Karibu Lodge, I tried to book online but I am not sure it went through:\n${details}`) });
      }
    } finally {
      setBusy(false);
    }
  });

  function showDone(b, room) {
    const ref   = bookingReference(b.id);
    const until = b.holdExpiresAt
      ? new Date(b.holdExpiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : null;
    const message = `Hello Karibu Lodge, I just booked online. Reference ${ref}, ` +
      `Room ${room.number}, ${fmtDate(b.checkIn)} to ${fmtDate(b.checkOut)}.`;

    el.done.innerHTML = `
      <div class="success-icon">✅</div>
      <h3>Room ${esc(room.number)} is held for you</h3>
      <p class="lb-small">Your booking reference</p>
      <div class="lb-ref">${esc(ref)}</div>
      <div class="lb-summary">
        <strong>${esc(b.guestName)}</strong><br>
        Room ${esc(room.number)} · ${esc(typeLabel(room))}<br>
        ${fmtDate(b.checkIn)} → ${fmtDate(b.checkOut)} · ${plural(b.nights, 'night')}<br>
        <span class="lb-total">${money(b.total)} TSH</span> · pay on arrival
      </div>
      <p class="lb-next">
        We will call or WhatsApp you on <strong>${esc(b.guestPhone)}</strong> to confirm.
        ${until ? `We are holding the room until <strong>${esc(until)}</strong>.` : ''}
      </p>
      ${payBlock(b)}
      <div class="lb-done-actions">
        <a class="btn btn-whatsapp" target="_blank" rel="noopener" href="${esc(waUrl(message))}">💬 Message reception</a>
        <button type="button" class="btn btn-outline" data-lb="again">Make another booking</button>
      </div>`;

    el.pick.hidden = true;
    el.done.hidden = false;
    el.done.querySelector('[data-lb="again"]').onclick = reset;
    wirePayment(b);
    el.done.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ── Paying to keep the room ───────────────────────────────────
     The hold runs out in two hours because a room cannot be kept all day for
     someone who may never arrive. A guest who pays the till is not in that
     position, so they can say so here. This only tells reception; reception
     checks their own phone and decides. Nothing on this page takes money. */

  const till = () => {
    const t = CONFIG.till;
    const number = String(t?.number ?? '').trim();
    return number && !number.includes('REPLACE_ME') ? { ...t, number } : null;
  };

  function payBlock(b) {
    const t = till();
    if (!t) return '';                     // no till set up: the hold is the only way
    return `
      <div class="lb-pay" data-lb="pay">
        <p class="lb-pay-lead">Arriving later than that?</p>
        <p class="lb-small">Pay the full <strong>${money(b.total)} TSH</strong> to
          <strong>${esc(t.name || 'our till')}</strong>, till <strong>${esc(t.number)}</strong>,
          then tell us below. Reception checks the payment on their own phone and
          keeps Room ${esc(b.roomNumber)} for you — no two-hour limit.</p>
        <div class="form-group">
          <label for="lb-payref">Reference from your payment message</label>
          <input type="text" id="lb-payref" placeholder="e.g. QWE4RT56YU" autocomplete="off" />
          <div class="error-msg" id="lb-payref-error"></div>
        </div>
        <button type="button" class="btn btn-primary" data-lb="paid">I have paid</button>
      </div>`;
  }

  function wirePayment(b) {
    const box = el.done.querySelector('[data-lb="pay"]');
    if (!box) return;
    const input = box.querySelector('#lb-payref');
    const error = box.querySelector('#lb-payref-error');
    const btn   = box.querySelector('[data-lb="paid"]');

    btn.onclick = async () => {
      const reference = input.value.trim();
      error.textContent = '';
      error.style.display = 'none';
      if (reference.length < 4) {
        error.textContent = 'Please copy the reference from the payment message on your phone.';
        error.style.display = 'block';
        return;
      }

      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'Telling reception…';
      try {
        await claimPayment(db, b.id, {
          reference, payerName: b.guestName, payerPhone: b.guestPhone,
        }, b.createdBy);
        box.innerHTML =
          `<p class="lb-pay-lead">Thank you — reception is checking your payment now.</p>
           <p class="lb-small">They will call or WhatsApp you on <strong>${esc(b.guestPhone)}</strong>
             once they see it. Room ${esc(b.roomNumber)} is being kept for you in the meantime.</p>`;
      } catch (err) {
        console.warn('[live booking] payment claim', err);
        btn.disabled = false;
        btn.textContent = label;
        error.textContent = err instanceof PaymentClaimError || err instanceof RoomUnavailableError
          ? err.message
          : 'We could not pass that on just now. Please message reception on WhatsApp with your reference.';
        error.style.display = 'block';
      }
    };
  }

  function reset() {
    el.name.value = '';
    el.phone.value = '';
    fieldError(el.name, el.nameErr, '');
    fieldError(el.phone, el.phoneErr, '');
    hideError();
    state.selected = null;
    el.done.hidden = true;
    el.done.innerHTML = '';
    el.pick.hidden = false;
    refresh();
  }

  await refresh();

  return {
    /** "Book Now" on a Deluxe card lists the deluxe rooms first. */
    setPreferredType(type) {
      state.preferredType = type;
      renderRooms();
    },
  };
}
