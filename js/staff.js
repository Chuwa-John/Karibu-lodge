// js/staff.js — the reception console.
//
// One Firestore listener drives every panel. At six rooms the whole live book
// is a few dozen documents, so it is cheaper and far simpler to hold the
// current window in memory and derive the views than to run a query per panel.

import { collection, onSnapshot, query, where } from 'firebase/firestore';

import { initFirebase, signInStaff, signOutStaff, watchStaffAuth } from './lib/firebase.js';
import {
  loadRooms, blockedFromCells, freeRooms, bookingReference,
  confirmBooking, cancelBooking, checkInGuest, checkOutGuest,
  sweepExpiredHolds, createBooking,
  RoomUnavailableError,
} from './lib/availability.js';
import { today, addDays, dateRange, fmtDate, countNights } from './lib/dates.js';
import { askText } from './lib/ask.js';
import { createAlertTracker, SOON_MINUTES } from './lib/alerts.js';
import { createChime } from './lib/chime.js';
import { mountAdmin, unmountAdmin } from './admin-ui.js';

const $ = sel => document.querySelector(sel);

const STAFF_ROLES = ['reception', 'admin'];
const AVAIL_DAYS  = 14;

const state = {
  db: null, auth: null,
  user: null, role: null,
  rooms: [],
  bookings: [],   // live window: everything not yet departed
  nights:   [],   // raw ledger cells; folded at render time, never cached
  unsubBookings: null,
  unsubNights: null,
  alerts: null,          // one tracker per signed-in session; see startConsole
  chime: createChime(),
  offlineSince: null,    // when the bookings listener last lost the server
  bookingsFromCache: true,   // true until the server has answered this session
  flashOn: false,
};

/** Whether a hold still blocks depends on the clock, so fold on every render
 *  rather than storing the answer. */
function blockedNow() { return blockedFromCells(state.nights); }

/* ── View switching ───────────────────────────────────────────── */

function show(view) {
  ['login', 'norole', 'console'].forEach(v => {
    $(`#view-${v}`).hidden = v !== view;
  });
}

function setError(sel, message) {
  const el = $(sel);
  el.textContent = message || '';
  el.hidden = !message;
}

/* ── Rendering helpers ────────────────────────────────────────── */

function roomChip(b) {
  const room = state.rooms.find(r => r.id === b.roomId);
  const cls  = room?.type === 'deluxe' ? 'roomchip deluxe' : 'roomchip';
  return `<div class="${cls}"><b>${b.roomNumber ?? '?'}</b>room</div>`;
}

function money(n) { return `${Number(n || 0).toLocaleString()} TSH`; }

function expiryLabel(b) {
  if (b.status !== 'pending' || !b.holdExpiresAt) return '';
  const ms = b.holdExpiresAt.toMillis ? b.holdExpiresAt.toMillis()
                                      : new Date(b.holdExpiresAt).getTime();
  const mins = Math.round((ms - Date.now()) / 60000);
  if (mins <= 0) return `<span class="expiry gone">hold lapsed</span>`;
  if (mins <= SOON_MINUTES) return `<span class="expiry urgent">${mins} min left</span>`;
  if (mins < 60) return `<span class="expiry">${mins} min left</span>`;
  return `<span class="expiry">${Math.floor(mins / 60)}h ${mins % 60}m left</span>`;
}

function bookingRow(b, actions) {
  const src = b.source === 'walkin' ? `<span class="tag tag-walkin">walk-in</span>` : '';
  return `
    <div class="row${state.alerts?.isWaiting(b.id) ? ' row-new' : ''}" data-id="${b.id}">
      ${roomChip(b)}
      <div>
        <div class="who-line">${esc(b.guestName)} <span class="tag tag-${b.status}">${b.status.replace('_', ' ')}</span> ${src}</div>
        <div class="meta">
          <span class="ref">${bookingReference(b.id)}</span><span class="sep">·</span>
          ${esc(b.guestPhone)}<span class="sep">·</span>
          ${fmtDate(b.checkIn)} → ${fmtDate(b.checkOut)}<span class="sep">·</span>
          ${b.nights} night${b.nights === 1 ? '' : 's'}<span class="sep">·</span>
          ${money(b.total)}
          ${expiryLabel(b) ? `<span class="sep">·</span>${expiryLabel(b)}` : ''}
        </div>
      </div>
      <div class="actions">${actions.map(a =>
        `<button class="btn btn-sm ${a.cls}" data-act="${a.act}" data-id="${b.id}">${a.label}</button>`
      ).join('')}</div>
    </div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderList(sel, rows, emptyText) {
  $(sel).innerHTML = rows.length ? rows.join('') : `<div class="empty">${emptyText}</div>`;
}

function setCount(sel, n, alert = false) {
  const el = $(sel);
  el.textContent = n;
  el.classList.toggle('alert', alert && n > 0);
}

/* ── The four panels ──────────────────────────────────────────── */

function render() {
  const t = today();
  const bs = state.bookings;

  const pending = bs.filter(b => b.status === 'pending')
    .sort((a, b) => (a.checkIn < b.checkIn ? -1 : 1));
  renderList('#list-pending', pending.map(b => bookingRow(b, [
    { act: 'confirm', label: 'Confirm', cls: 'btn-ok' },
    { act: 'cancel',  label: 'Decline', cls: 'btn-danger' },
  ])), 'Nothing waiting. New web bookings appear here the moment they arrive.');
  setCount('#count-pending', pending.length, true);

  const arrivals = bs.filter(b => b.checkIn === t && b.status === 'confirmed');
  renderList('#list-arrivals', arrivals.map(b => bookingRow(b, [
    { act: 'checkin', label: 'Check in', cls: 'btn-primary' },
  ])), 'No arrivals today.');
  setCount('#count-arrivals', arrivals.length);

  const departures = bs.filter(b => b.checkOut === t && b.status === 'checked_in');
  renderList('#list-departures', departures.map(b => bookingRow(b, [
    { act: 'checkout', label: 'Check out', cls: 'btn-primary' },
  ])), 'No departures today.');
  setCount('#count-departures', departures.length);

  const inhouse = bs.filter(b => b.status === 'checked_in');
  renderList('#list-inhouse', inhouse.map(b => bookingRow(b, [
    { act: 'checkout', label: 'Check out', cls: 'btn-ghost' },
  ])), 'Nobody checked in.');
  setCount('#count-inhouse', inhouse.length);

  renderAvailability();
}

function renderAvailability() {
  const from  = today();
  const to    = addDays(from, AVAIL_DAYS - 1);
  const dates = dateRange(from, to);

  const header = `<div class="avail-row"><span></span>
    <div class="avail-dates">${dates.map(d =>
      `<span>${d.slice(8)}</span>`).join('')}</div></div>`;

  const blocked = blockedNow();
  const rows = state.rooms.map(room => {
    const taken = blocked.get(room.id) || new Set();
    const cells = dates.map(d => {
      const held = taken.has(d);
      return `<div class="cell ${held ? 'taken' : ''}" title="Room ${room.number} · ${d}"></div>`;
    }).join('');
    return `<div class="avail-row">
      <span class="meta">Room ${room.number}</span>
      <div class="avail-cells">${cells}</div>
    </div>`;
  });

  $('#avail-grid').innerHTML = header + rows.join('');
}

/* ── Live data ────────────────────────────────────────────────── */

async function startConsole() {
  state.rooms = await loadRooms(state.db);

  const onErr = err => setError('#console-error', `Live updates stopped: ${err.message}`);

  state.alerts = createAlertTracker();
  state.bookingsFromCache = true;
  renderSound();

  // Everything not yet departed. One range filter, so no composite index.
  // includeMetadataChanges: a snapshot served from cache means the server is out
  // of reach, and with it every new booking — that has to be visible.
  state.unsubBookings = onSnapshot(
    query(collection(state.db, 'bookings'), where('checkOut', '>=', today())),
    { includeMetadataChanges: true },
    snap => {
      state.bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      state.bookingsFromCache = snap.metadata.fromCache;
      setLive(snap.metadata.fromCache);
      onBookingsChanged();
      render();
    },
    onErr);

  // The ledger needs its own listener: night cells change without any booking
  // in this window changing — a walk-in taken at another terminal, a guest's
  // hold landing, reception releasing a room.
  state.unsubNights = onSnapshot(
    query(collection(state.db, 'nights'),
      where('date', '>=', today()), where('date', '<=', addDays(today(), 60))),
    snap => { state.nights = snap.docs.map(d => d.data()); render(); },
    onErr);
}

/* ── Actions ──────────────────────────────────────────────────── */

async function withButton(btn, fn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  setError('#console-error', '');
  try {
    await fn();
  } catch (err) {
    setError('#console-error', err.message || String(err));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

const ACTIONS = {
  confirm:  id => confirmBooking(state.db, id, state.user.uid),
  checkin:  id => checkInGuest(state.db, id, state.user.uid),
  checkout: id => checkOutGuest(state.db, id, state.user.uid),
  cancel: async id => {
    const b = state.bookings.find(x => x.id === id);
    const reason = await askText(
      `${b ? b.guestName : 'This guest'} will lose the room and the nights go back on sale. ` +
      'The reason is kept on the record.',
      { title: 'Decline this booking?', label: 'Reason', required: true, danger: true,
        okLabel: 'Decline booking', cancelLabel: 'Keep booking' });
    if (reason === null) return;          // backed out: do nothing
    return cancelBooking(state.db, id, reason.trim(), state.user.uid);
  },
};

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === 'signout')       return signOutStaff();
  if (act === 'ack')           return acknowledgeAlerts();
  if (act === 'sound')         return testSound();
  if (act === 'walkin')        return openWalkin();
  if (act === 'walkin-close')  return closeWalkin();
  if (act === 'sweep') {
    return withButton(btn, async () => {
      const swept = await sweepExpiredHolds(state.db, state.user.uid);
      setError('#console-error', swept.length ? '' : 'No lapsed holds to clear.');
    });
  }

  const handler = ACTIONS[act];
  if (handler) return withButton(btn, () => handler(btn.dataset.id));
});

/* ── Walk-in ──────────────────────────────────────────────────── */

function openWalkin() {
  setError('#walkin-error', '');
  $('#walkin-total').hidden = true;
  $('#walkin-form').reset();
  const t = today();
  $('#w-checkin').min  = t;
  $('#w-checkout').min = addDays(t, 1);
  $('#w-checkin').value  = t;
  $('#w-checkout').value = addDays(t, 1);
  $('#walkin-modal').hidden = false;
  refreshWalkinRooms();
}

function closeWalkin() { $('#walkin-modal').hidden = true; }

function refreshWalkinRooms() {
  const checkIn  = $('#w-checkin').value;
  const checkOut = $('#w-checkout').value;
  const select   = $('#w-room');

  if (!checkIn || !checkOut || checkOut <= checkIn) {
    select.innerHTML = '<option value="">— choose valid dates —</option>';
    $('#walkin-total').hidden = true;
    return;
  }

  const free = freeRooms(state.rooms, blockedNow(), checkIn, checkOut);

  select.innerHTML = free.length
    ? free.map(r => `<option value="${r.id}">Room ${r.number} · ${r.type} · ${money(r.rate)}/night</option>`).join('')
    : '<option value="">— no rooms free for those dates —</option>';

  updateWalkinTotal();
}

function updateWalkinTotal() {
  const roomId = $('#w-room').value;
  const room   = state.rooms.find(r => r.id === roomId);
  const box    = $('#walkin-total');
  const ci = $('#w-checkin').value, co = $('#w-checkout').value;

  if (!room || !ci || !co || co <= ci) { box.hidden = true; return; }
  const n = countNights(ci, co);
  box.textContent = `${n} night${n === 1 ? '' : 's'} × ${money(room.rate)} = ${money(n * room.rate)} — payable on arrival`;
  box.hidden = false;
}

$('#w-checkin').addEventListener('change', () => {
  $('#w-checkout').min = addDays($('#w-checkin').value, 1);
  if ($('#w-checkout').value <= $('#w-checkin').value) {
    $('#w-checkout').value = addDays($('#w-checkin').value, 1);
  }
  refreshWalkinRooms();
});
$('#w-checkout').addEventListener('change', refreshWalkinRooms);
$('#w-room').addEventListener('change', updateWalkinTotal);

$('#walkin-form').addEventListener('submit', async e => {
  e.preventDefault();
  setError('#walkin-error', '');
  const btn = $('#walkin-submit');

  await withButton(btn, async () => {
    try {
      await createBooking(state.db, {
        roomId:     $('#w-room').value,
        checkIn:    $('#w-checkin').value,
        checkOut:   $('#w-checkout').value,
        guestName:  $('#w-name').value,
        guestPhone: $('#w-phone').value,
        notes:      $('#w-notes').value,
        uid:        state.user.uid,
        source:     'walkin',
        status:     'confirmed',   // taken at the desk: already agreed
      });
      closeWalkin();
    } catch (err) {
      const msg = err instanceof RoomUnavailableError
        ? `That room was taken while you were typing (${err.takenDates.join(', ')}). Pick another.`
        : err.message;
      setError('#walkin-error', msg);
      refreshWalkinRooms();   // the modal shows the problem; the console banner stays quiet
    }
  });
});

/* ── Sign in ──────────────────────────────────────────────────── */

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  state.chime.unlock();   // this click is the one moment the browser will let sound start
  setError('#login-error', '');
  const btn = $('#login-btn');
  btn.disabled = true;
  try {
    await signInStaff($('#email').value, $('#password').value);
  } catch (err) {
    const friendly = /invalid-credential|wrong-password|user-not-found/.test(err.code || '')
      ? 'Email or password not recognised.'
      : err.message;
    setError('#login-error', friendly);
  } finally {
    btn.disabled = false;
  }
});

/* ── Boot ─────────────────────────────────────────────────────── */

try {
  const { db, auth } = initFirebase();
  state.db = db; state.auth = auth;

  watchStaffAuth(async info => {
    if (state.unsubBookings) { state.unsubBookings(); state.unsubBookings = null; }
    if (state.unsubNights)   { state.unsubNights();   state.unsubNights = null; }
    state.alerts = null;
    state.offlineSince = null;
    renderAlerts();
    unmountAdmin();

    if (!info) { state.user = null; state.role = null; return show('login'); }

    state.user = info.user;
    state.role = info.role;

    if (!STAFF_ROLES.includes(info.role)) return show('norole');

    $('#who-name').textContent = info.user.email || 'staff';
    $('#who-role').textContent = info.role;
    show('console');
    await startConsole();
    if (info.role === 'admin') {
      mountAdmin({ db: state.db, user: info.user, liveBookings: () => state.bookings });
    }
  });
} catch (err) {
  document.body.innerHTML =
    `<div class="login"><div class="panel"><h1>Not configured</h1>
     <p class="sub">${esc(err.message)}</p></div></div>`;
}

/* ── Alerts ───────────────────────────────────────────────────────
   A web booking holds its room for two hours and then quietly goes back on
   sale, so the desk has to notice it. The bell rings when one arrives and again
   every half minute until someone presses "Got it" or deals with it; the tab
   title flashes; and anything that would stop the alert working — the browser
   blocking sound, or the live connection dropping — goes on screen instead of
   failing quietly. The rules themselves live in js/lib/alerts.js. */

const RING_EVERY_MS    = 30_000;
const OFFLINE_GRACE_MS = 4_000;
const BASE_TITLE       = document.title;

function onBookingsChanged() {
  if (!state.alerts) return;
  const { arrivals, lapsingSoon } = state.alerts.update(
    state.bookings, Date.now(), { fromCache: state.bookingsFromCache });
  if (arrivals.length) {
    state.chime.play('arrival');
    restartRingTimer();
  } else {
    warnIfLapsing(lapsingSoon);
  }
  renderAlerts();
}

/** The arrival bell outranks this one. A warning only counts once it has
 *  actually played, so one raised while sound was blocked is kept, not lost. */
function warnIfLapsing(lapsingSoon) {
  if (!lapsingSoon.length || state.alerts.waiting.length) return;
  if (state.chime.play('soon')) state.alerts.markHeard(lapsingSoon);
}

/** Ring for whatever needs it right now. Used by the half-minute tick, and at
 *  the moment a click turns sound on, so nothing that happened meanwhile is lost. */
function ringOutstanding() {
  if (!state.alerts) return;
  const { lapsingSoon } = state.alerts.update(
    state.bookings, Date.now(), { fromCache: state.bookingsFromCache });
  if (state.alerts.waiting.length) state.chime.play('arrival');
  else warnIfLapsing(lapsingSoon);
  renderAlerts();
}

function renderAlerts() {
  const waiting = state.alerts ? state.alerts.waiting : [];
  $('#alert-banner').hidden = waiting.length === 0;
  if (waiting.length === 1) {
    const b = waiting[0];
    $('#alert-text').textContent =
      `New booking: ${b.guestName} · Room ${b.roomNumber} · ` +
      `${fmtDate(b.checkIn)} → ${fmtDate(b.checkOut)} · ${bookingReference(b.id)}`;
  } else if (waiting.length > 1) {
    $('#alert-text').textContent = `${waiting.length} new bookings waiting: ` +
      waiting.map(b => `${b.guestName} (Room ${b.roomNumber})`).join(', ');
  } else {
    document.title = BASE_TITLE;
  }
}

function acknowledgeAlerts() {
  state.alerts?.acknowledge();
  renderAlerts();
  render();
}

function renderSound() {
  const s = state.chime.state;
  const chip = $('#sound-chip');
  chip.dataset.state = s;
  chip.disabled = s === 'unsupported';
  chip.textContent = s === 'running' ? '🔔 Sound on'
                   : s === 'unsupported' ? '🔕 No sound' : '🔕 Sound off';
  const warn = $('#sound-warning');
  warn.hidden = s === 'running';
  warn.textContent = s === 'unsupported'
    ? 'This browser cannot play the booking bell. Keep this screen in view.'
    : 'The booking bell is OFF. Browsers block sound until someone clicks the page — click anywhere here to turn it on.';
}

async function testSound() {
  await state.chime.unlock();
  state.chime.play('test');
  renderSound();
}

function setLive(fromCache) {
  if (!fromCache) {
    state.offlineSince = null;
  } else if (state.offlineSince === null) {
    state.offlineSince = Date.now();
    setTimeout(renderLive, OFFLINE_GRACE_MS + 100);   // a brief blip is not worth a warning
  }
  renderLive();
}

function renderLive() {
  const lostServer = state.offlineSince !== null && Date.now() - state.offlineSince >= OFFLINE_GRACE_MS;
  $('#live-warning').hidden = !(state.user && (lostServer || navigator.onLine === false));
}

state.chime.onChange(renderSound);

// The moment sound comes on, ring for anything that arrived while it was off.
let lastSound = state.chime.state;
state.chime.onChange(s => {
  if (s === 'running' && lastSound !== 'running') {
    ringOutstanding();
    restartRingTimer();
  }
  lastSound = s;
});
renderSound();

// Every click or key press is a chance to unlock the bell.
['pointerdown', 'keydown'].forEach(type =>
  document.addEventListener(type, () => {
    if (state.chime.state === 'suspended') state.chime.unlock();
  }, { capture: true }));

window.addEventListener('online', renderLive);
window.addEventListener('offline', renderLive);

// Flash the tab title while anything is waiting, so it shows in the taskbar.
setInterval(() => {
  const n = state.alerts ? state.alerts.waiting.length : 0;
  if (!n) return;
  state.flashOn = !state.flashOn;
  document.title = state.flashOn ? `🛎️ (${n}) New booking` : `(${n}) ${BASE_TITLE}`;
}, 1000);

// Every half minute: countdowns go stale, holds edge towards lapsing without any
// document changing, and anything still waiting rings again.
function tick() {
  if (!state.rooms.length) return;
  ringOutstanding();
  render();
}
let ringTimer = setInterval(tick, RING_EVERY_MS);

/** The repeat is measured from the latest ring, not from when the page loaded.
 *  Measured 2026-09-11: on a fixed cadence a booking that landed just before
 *  the tick rang, then rang again a moment later, which sounds like a fault. */
function restartRingTimer() {
  clearInterval(ringTimer);
  ringTimer = setInterval(tick, RING_EVERY_MS);
}
