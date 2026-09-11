// js/booking.js

/* ── Helpers ── */
function sanitize(str, maxLen = 200) {
  return String(str).replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
}

function cap(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function calcNights(checkIn, checkOut) {
  const ms = new Date(checkOut) - new Date(checkIn);
  return Math.max(1, Math.round(ms / 86400000));
}

function fmtDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

/* ── Validation ── */
function validateForm(fields) {
  let valid = true;
  fields.forEach(({ el, errorEl, check, message }) => {
    if (!el) return;
    const ok = check(el.value.trim());
    el.classList.toggle('error', !ok);
    if (errorEl) {
      errorEl.textContent = ok ? '' : message;
      errorEl.style.display = ok ? 'none' : 'block';
    }
    if (!ok) valid = false;
  });
  return valid;
}

/* ── Success Message ── */
function showSuccess(data) {
  const { name, room, checkIn, checkOut, waUrl, blocked } = data;
  const nights = calcNights(checkIn, checkOut);
  const pricePerNight = room === 'deluxe' ? 30000 : 20000;
  const total = nights * pricePerNight;

  const successEl = document.getElementById('success-message');
  const summaryEl = document.getElementById('booking-summary');
  if (!successEl) return;

  if (summaryEl) {
    summaryEl.innerHTML =
      `<strong>${sanitize(name)}</strong> · ${cap(sanitize(room))} Room<br>` +
      `${fmtDate(checkIn)} → ${fmtDate(checkOut)} · ${nights} night${nights !== 1 ? 's' : ''}<br>` +
      `<span style="color:var(--gold-dark);font-weight:600">Total: ${total.toLocaleString()} TSH</span>`;
  }

  successEl.style.display = 'block';
  successEl.classList.add('show');
  successEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Point every WhatsApp link at this booking, so the button in the panel
  // carries the same details we just tried to hand off.
  document.querySelectorAll('.cfg-whatsapp').forEach(el => {
    el.href = waUrl;
  });

  // A blocked hand-off means nothing has reached the lodge. Say that plainly
  // instead of telling the guest their booking was received.
  const notice = document.getElementById('wa-blocked-notice');
  const icon   = document.getElementById('success-icon');
  const title  = document.getElementById('success-title');
  const note   = document.getElementById('success-note');

  if (notice) notice.style.display = blocked ? 'block' : 'none';
  if (icon)   icon.textContent  = blocked ? '⚠️' : '✅';
  if (title)  title.textContent = blocked ? 'One More Tap Needed' : 'Booking Received!';
  if (note)   note.textContent  = blocked
    ? 'Your booking is ready to send — we have not received it yet.'
    : "Thank you for choosing Karibu Lodge. We'll contact you within 1 hour to confirm.";
}

/* ── Main Init ── */
export function initBooking(CONFIG) {
  const today      = new Date().toISOString().split('T')[0];
  const checkInEl  = document.getElementById('checkin');
  const checkOutEl = document.getElementById('checkout');

  // Set minimum dates
  if (checkInEl)  checkInEl.min  = today;
  if (checkOutEl) checkOutEl.min = today;

  // Update checkout min when checkin changes
  if (checkInEl && checkOutEl) {
    checkInEl.addEventListener('change', () => {
      checkOutEl.min = checkInEl.value;
      if (checkOutEl.value && checkOutEl.value <= checkInEl.value) {
        checkOutEl.value = '';
      }
    });
  }

  // Pre-select room from [data-room] clicks
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-room]');
    if (!btn) return;
    const roomSelect = document.getElementById('room-type');
    if (roomSelect) roomSelect.value = btn.dataset.room;
  });

  // Form submit
  const form = document.getElementById('booking-form');
  if (!form) return;

  form.addEventListener('submit', e => {
    e.preventDefault();

    const nameEl  = document.getElementById('name');
    const phoneEl = document.getElementById('phone');
    const roomEl  = document.getElementById('room-type');

    const fields = [
      {
        el: nameEl,
        errorEl: document.getElementById('name-error'),
        check: v => v.length >= 2 && v.length <= 100,
        message: 'Please enter your full name (2–100 characters).'
      },
      {
        el: phoneEl,
        errorEl: document.getElementById('phone-error'),
        check: v => /^[\d\s\+\-\(\)]{7,20}$/.test(v),
        message: 'Please enter a valid phone number.'
      },
      {
        el: roomEl,
        errorEl: document.getElementById('room-type-error'),
        check: v => ['standard', 'deluxe'].includes(v),
        message: 'Please select a room type.'
      },
      {
        el: checkInEl,
        errorEl: document.getElementById('checkin-error'),
        check: v => !!v && v >= today,
        message: 'Please select a valid check-in date.'
      },
      {
        el: checkOutEl,
        errorEl: document.getElementById('checkout-error'),
        check: v => !!v && v > (checkInEl?.value || today),
        message: 'Check-out must be after check-in.'
      },
    ];

    if (!validateForm(fields)) return;

    const name      = nameEl.value.trim();
    const room      = roomEl.value;
    const checkIn   = checkInEl.value;
    const checkOut  = checkOutEl.value;
    const nights    = calcNights(checkIn, checkOut);
    const price     = room === 'deluxe' ? 30000 : 20000;
    const total     = nights * price;
    const roomLabel = room === 'deluxe' ? 'Deluxe Room' : 'Standard Room';

    const waMsg = encodeURIComponent(
      `🏨 *New Booking — Karibu Lodge*\n\n` +
      `👤 *Name:* ${name}\n` +
      `🛏 *Room:* ${roomLabel}\n` +
      `📅 *Check-in:* ${checkIn}\n` +
      `📅 *Check-out:* ${checkOut}\n` +
      `🌙 *Nights:* ${nights}\n` +
      `💰 *Total:* TSH ${total.toLocaleString()}\n` +
      `📞 *Phone:* ${phoneEl.value.trim()}`
    );
    const waUrl = `https://wa.me/${CONFIG.whatsapp}?text=${waMsg}`;

    // Hand off to WhatsApp NOW, while we are still inside the click gesture
    // that fired this submit. Deferring it into the setTimeout below breaks
    // the gesture chain, so pop-up blockers swallow it silently and the guest
    // is told "Booking Received!" with nothing actually sent.
    const waWindow = window.open(waUrl, '_blank');
    const blocked  = !waWindow || waWindow.closed || typeof waWindow.closed === 'undefined';

    // Loading state
    const submitBtn = form.querySelector('.btn-submit');
    submitBtn.classList.add('loading');
    submitBtn.disabled = true;

    setTimeout(() => {
      submitBtn.classList.remove('loading');
      submitBtn.disabled = false;

      form.style.display = 'none';
      showSuccess({ name, room, checkIn, checkOut, waUrl, blocked });
    }, 800);
  });

  // "New Booking" reset button
  const resetBtn = document.getElementById('booking-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      form.reset();
      form.style.display = '';
      const successEl = document.getElementById('success-message');
      if (successEl) {
        successEl.classList.remove('show');
        successEl.style.display = 'none';
      }
    });
  }
}

/* ── Live booking ─────────────────────────────────────────────────
   Progressive enhancement over the WhatsApp form above, which stays exactly
   as it was and is what the guest gets whenever live booking cannot start:
   switched off in config, Firebase not configured yet, the CDN blocked, or no
   connection. Loaded the first time the booking page opens, so the rest of
   the site never downloads Firebase.                                        */

export function initLiveBooking(CONFIG) {
  if (CONFIG.liveBooking === false) return;

  const wa      = document.getElementById('wa-booking');
  const loading = document.getElementById('live-loading');
  const live    = document.getElementById('live-booking');
  if (!wa || !loading || !live) return;

  let started = false;
  let api = null;
  let preferredType = null;

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-room]');
    if (!btn) return;
    preferredType = btn.dataset.room;
    api?.setPreferredType(preferredType);
  });

  async function start() {
    if (started) return;
    started = true;
    wa.hidden = true;
    loading.hidden = false;
    try {
      // Ask the tiny env module first. Until Firebase is configured there is
      // nothing to connect to, so the guest should not download it at all.
      const { IS_CONFIGURED } = await import('./lib/env.js');
      if (!IS_CONFIGURED) throw new Error('Firebase is not configured yet');
      const mod = await import('./guest-booking.js');
      api = await mod.mountLiveBooking({ CONFIG, preferredType });
      if (preferredType) api.setPreferredType(preferredType);
      loading.hidden = true;
      live.hidden = false;
    } catch (err) {
      console.warn('[live booking] unavailable, using the WhatsApp form instead:', err);
      loading.hidden = true;
      live.hidden = true;
      wa.hidden = false;
    }
  }

  window.addEventListener('pagechange', e => { if (e.detail === 'booking') start(); });
}