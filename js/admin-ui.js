// js/admin-ui.js — the owner's tabs inside the reception console.
//
// Mounted only for the admin role. Hiding these tabs from reception is a
// convenience, nothing more: the security rules are what actually refuse
// reception a price change or a look at the record.

import { updateRoom, loadAudit, loadStaff, loadNightCells, checkRate } from './lib/admin.js';
import { loadRooms } from './lib/availability.js';
import { summarize, monthSpan } from './lib/reports.js';
import { AUDIT_LABELS } from './lib/audit.js';
import { askConfirm } from './lib/ask.js';
import { today, fmtDate } from './lib/dates.js';

const TABS = ['desk', 'reports', 'rooms', 'staff', 'audit'];

const $   = sel => document.querySelector(sel);
const tsh = n => `${Number(n || 0).toLocaleString('en-GB')} TSH`;
const pct = x => `${Math.round(x * 100)}%`;
const digits = s => String(s ?? '').replace(/[,\s]/g, '');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setNotice(sel, message, kind = 'bad') {
  const el = $(sel);
  el.textContent = message || '';
  el.hidden = !message;
  el.classList.toggle('notice-bad', kind === 'bad');
  el.classList.toggle('notice-ok', kind === 'ok');
}

function shiftMonth(month, by) {
  const [y, m] = (month || today().slice(0, 7)).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

function when(ts) {
  const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

let ctx = null;        // { db, user, liveBookings } while an owner is signed in
let wired = false;     // listeners are attached once; ctx changes underneath them
const tokens = { report: 0, rooms: 0, staff: 0, audit: 0 };

export function mountAdmin(context) {
  ctx = context;
  if (!wired) wire();
  $('#admin-tabs').hidden = false;
  if (!$('#rep-month').value) $('#rep-month').value = today().slice(0, 7);
  show('desk');
}

export function unmountAdmin() {
  ctx = null;
  $('#admin-tabs').hidden = true;
  show('desk');
}

function show(name) {
  for (const b of document.querySelectorAll('#admin-tabs [data-tab]')) {
    const on = b.dataset.tab === name;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== name;
  if (!ctx) return;
  if (name === 'reports') renderReport();
  if (name === 'rooms')   renderRooms();
  if (name === 'staff')   renderStaff();
  if (name === 'audit')   renderAudit();
}

function wire() {
  wired = true;

  $('#admin-tabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (btn) show(btn.dataset.tab);
  });

  $('#rep-month').addEventListener('change', renderReport);
  $('#tab-reports').addEventListener('click', e => {
    const btn = e.target.closest('[data-rep]');
    if (!btn) return;
    $('#rep-month').value = shiftMonth($('#rep-month').value, btn.dataset.rep === 'next' ? 1 : -1);
    renderReport();
  });

  $('#rooms-table').addEventListener('input', onRoomEdited);
  $('#rooms-table').addEventListener('click', onRoomSave);

  $('#tab-audit').addEventListener('click', e => {
    if (e.target.closest('[data-audit="refresh"]')) renderAudit();
  });
}

/* ── Reports ──────────────────────────────────────────────────── */

const kpi = (label, value, sub) =>
  `<div class="kpi"><div class="kpi-label">${esc(label)}</div>` +
  `<div class="kpi-value">${esc(value)}</div><div class="kpi-sub">${esc(sub)}</div></div>`;

async function renderReport() {
  if (!ctx) return;
  const mine = ++tokens.report;
  setNotice('#rep-error', '');

  let span;
  try { span = monthSpan($('#rep-month').value); }
  catch { return setNotice('#rep-error', 'Pick a month.'); }

  $('#rep-kpis').innerHTML = '<div class="empty">Working it out…</div>';
  try {
    const [rooms, cells] = await Promise.all([loadRooms(ctx.db), loadNightCells(ctx.db, span.from, span.to)]);
    if (mine !== tokens.report) return;
    drawReport(summarize({ rooms, cells, from: span.from, to: span.to }), span);
  } catch (err) {
    if (mine !== tokens.report) return;
    $('#rep-kpis').innerHTML = '';
    setNotice('#rep-error', `Could not load the report: ${err.message}`);
  }
}

function drawReport(r, span) {
  $('#rep-kpis').innerHTML = [
    kpi('Occupancy', pct(r.occupancy), `${r.sold} of ${r.capacity} room-nights sold`),
    kpi('Revenue', tsh(r.revenue), 'confirmed nights, as charged'),
    kpi('Average rate', tsh(r.averageRate), 'per night sold'),
    kpi('Per available night', tsh(r.revenuePerAvailableNight), 'revenue ÷ nights there were to sell'),
    kpi('On hold', String(r.held), `night${r.held === 1 ? '' : 's'} not yet confirmed — not counted`),
  ].join('');

  const notes = [`${fmtDate(span.from)} – ${fmtDate(span.to)}. Nights later this month count once they are confirmed.`];
  if (r.unpriced) {
    notes.push(`${r.unpriced} confirmed night${r.unpriced === 1 ? ' has' : 's have'} no price on record and count as 0.`);
  }
  const off = r.byRoom.filter(x => !x.active).map(x => x.number);
  if (off.length) {
    notes.push(`${off.length === 1 ? 'Room' : 'Rooms'} ${off.join(', ')} ${off.length === 1 ? 'is' : 'are'} off sale now but still counted as available.`);
  }
  $('#rep-note').textContent = notes.join(' ');

  const scale = Math.max(1, r.rooms);
  $('#rep-days').innerHTML = r.byDay.map(d => `
    <div class="rep-day" title="${esc(fmtDate(d.date))}: ${d.sold} sold, ${d.held} on hold, ${esc(tsh(d.revenue))}">
      <div class="rep-bar">
        <span class="rep-sold" style="height:${(d.sold / scale) * 100}%"></span>
        <span class="rep-held" style="height:${(d.held / scale) * 100}%"></span>
      </div>
      <div class="rep-date">${esc(d.date.slice(8))}</div>
    </div>`).join('');

  $('#rep-rooms').innerHTML = `
    <thead><tr>
      <th>Room</th><th>Type</th><th class="num">Price now</th>
      <th class="num">Nights sold</th><th class="num">Occupancy</th><th class="num">Revenue</th>
    </tr></thead>
    <tbody>${r.byRoom.map(x => `
      <tr>
        <td>Room ${esc(x.number)}${x.active ? '' : ' <span class="tag tag-cancelled">off sale</span>'}</td>
        <td>${esc(x.type)}</td>
        <td class="num">${esc(tsh(x.rate))}</td>
        <td class="num">${x.sold}</td>
        <td class="num">${pct(x.occupancy)}</td>
        <td class="num">${esc(tsh(x.revenue))}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot><tr>
      <th colspan="3">All rooms</th><th class="num">${r.sold}</th>
      <th class="num">${pct(r.occupancy)}</th><th class="num">${esc(tsh(r.revenue))}</th>
    </tr></tfoot>`;
}

/* ── Rooms & prices ───────────────────────────────────────────── */

async function renderRooms() {
  if (!ctx) return;
  const mine = ++tokens.rooms;
  const table = $('#rooms-table');
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';

  let rooms;
  try { rooms = await loadRooms(ctx.db); }
  catch (err) {
    if (mine === tokens.rooms) setNotice('#rooms-notice', `Could not load rooms: ${err.message}`);
    return;
  }
  if (mine !== tokens.rooms) return;

  table.innerHTML = `
    <thead><tr><th>Room</th><th>Type</th><th>Price a night (TSH)</th><th>On sale</th><th></th></tr></thead>
    <tbody>${rooms.map(r => {
      const on = r.active !== false;
      return `
      <tr data-room="${esc(r.id)}" data-number="${esc(r.number)}">
        <td>Room ${esc(r.number)}</td>
        <td>${esc(r.type)}</td>
        <td><input type="text" inputmode="numeric" class="rate-input"
                   value="${esc(Number(r.rate).toLocaleString('en-GB'))}" data-was="${esc(r.rate)}"
                   aria-label="Price for room ${esc(r.number)}" /></td>
        <td><label class="switch"><input type="checkbox" class="active-input" ${on ? 'checked' : ''}
                   data-was="${on}" aria-label="Room ${esc(r.number)} on sale" />
            <span>${on ? 'On sale' : 'Off sale'}</span></label></td>
        <td class="num"><button type="button" class="btn btn-sm btn-primary" data-save="${esc(r.id)}" disabled>Save</button></td>
      </tr>`;
    }).join('')}</tbody>`;
}

function pendingChanges(row) {
  const rateEl   = row.querySelector('.rate-input');
  const activeEl = row.querySelector('.active-input');
  return {
    rateChanged:   digits(rateEl.value) !== rateEl.dataset.was,
    activeChanged: String(activeEl.checked) !== activeEl.dataset.was,
    rateEl, activeEl,
  };
}

function onRoomEdited(e) {
  const row = e.target.closest('tr[data-room]');
  if (!row) return;
  const { rateChanged, activeChanged, activeEl } = pendingChanges(row);
  activeEl.nextElementSibling.textContent = activeEl.checked ? 'On sale' : 'Off sale';
  row.querySelector('[data-save]').disabled = !(rateChanged || activeChanged);
}

async function onRoomSave(e) {
  const btn = e.target.closest('[data-save]');
  if (!btn || btn.disabled || !ctx) return;

  const row    = btn.closest('tr[data-room]');
  const roomId = row.dataset.room;
  const name   = `Room ${row.dataset.number}`;
  const { rateChanged, activeChanged, rateEl, activeEl } = pendingChanges(row);
  setNotice('#rooms-notice', '');

  const changes = {};
  if (rateChanged) {
    try { changes.rate = checkRate(rateEl.value); }
    catch (err) { return setNotice('#rooms-notice', `${name}: ${err.message}`); }
  }
  if (activeChanged) changes.active = activeEl.checked;

  const lines = [];
  if ('rate' in changes) {
    lines.push(`${name} will cost ${tsh(changes.rate)} a night instead of ${tsh(rateEl.dataset.was)}. Bookings already made keep their price.`);
  }
  if (changes.active === false) {
    const upcoming = ctx.liveBookings()
      .filter(b => b.roomId === roomId && ['pending', 'confirmed', 'checked_in'].includes(b.status)).length;
    lines.push(`${name} will be taken off sale, so guests cannot book it.` +
      (upcoming ? ` It still has ${upcoming} upcoming booking${upcoming === 1 ? '' : 's'}, which are NOT cancelled.` : ''));
  }
  if (changes.active === true) lines.push(`${name} will be put back on sale.`);

  const agreed = await askConfirm(lines.join(' '), {
    title: 'Change this room?', okLabel: 'Save change', cancelLabel: 'Keep it as it was',
  });
  if (!agreed) return;

  btn.disabled = true;
  btn.textContent = '…';
  try {
    const result = await updateRoom(ctx.db, roomId, changes, ctx.user.uid);
    await renderRooms();
    setNotice('#rooms-notice', result.changed ? `Saved — ${name} updated.` : 'Nothing had changed.', 'ok');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Save';
    setNotice('#rooms-notice', err.code === 'permission-denied'
      ? 'Only the owner can change rooms.' : `${name}: ${err.message}`);
  }
}

/* ── Staff ────────────────────────────────────────────────────── */

async function renderStaff() {
  if (!ctx) return;
  const mine = ++tokens.staff;
  const table = $('#staff-table');
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    const people = await loadStaff(ctx.db);
    if (mine !== tokens.staff) return;
    table.innerHTML = `
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th></tr></thead>
      <tbody>${people.map(p => {
        const removed = p.active === false || p.role === 'none';
        return `<tr>
          <td>${esc(p.name || '—')}</td><td>${esc(p.email || '—')}</td>
          <td>${esc(removed ? '—' : p.role)}</td>
          <td>${removed ? '<span class="tag tag-cancelled">removed</span>' : '<span class="tag tag-confirmed">active</span>'}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="4" class="empty">No staff recorded.</td></tr>'}</tbody>`;
  } catch (err) {
    if (mine === tokens.staff) {
      table.innerHTML = `<tbody><tr><td class="empty">Could not load staff: ${esc(err.message)}</td></tr></tbody>`;
    }
  }
}

/* ── The record ───────────────────────────────────────────────── */

async function renderAudit() {
  if (!ctx) return;
  const mine = ++tokens.audit;
  setNotice('#audit-error', '');
  const table = $('#audit-table');
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    const [entries, people] = await Promise.all([loadAudit(ctx.db, 100), loadStaff(ctx.db)]);
    if (mine !== tokens.audit) return;
    const names = new Map(people.map(p => [p.uid, p.name || p.email]));
    table.innerHTML = `
      <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
      <tbody>${entries.map(e => `<tr>
        <td class="nowrap">${esc(when(e.at))}</td>
        <td>${esc(names.get(e.actor) || e.actor)}</td>
        <td>${esc(AUDIT_LABELS[e.action] || e.action)}</td>
        <td>${esc(e.summary)}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing recorded yet.</td></tr>'}</tbody>`;
  } catch (err) {
    if (mine !== tokens.audit) return;
    table.innerHTML = '';
    setNotice('#audit-error', err.code === 'permission-denied'
      ? 'Only the owner can read the record.' : `Could not load the record: ${err.message}`);
  }
}
