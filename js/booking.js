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
function showSuccess(data, CONFIG) {
  const { name, room, checkIn, checkOut } = data;
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

  // Update all WhatsApp links with booking details
  const waMsg = encodeURIComponent(
    `Hello Karibu Lodge! I'd like to confirm my booking:\n` +
    `Name: ${sanitize(name)}\n` +
    `Room: ${cap(sanitize(room))} Room\n` +
    `Check-in: ${fmtDate(checkIn)}\n` +
    `Check-out: ${fmtDate(checkOut)}\n` +
    `Nights: ${nights}\n` +
    `Estimated Total: TSH ${total.toLocaleString()}`
  );
  document.querySelectorAll('.cfg-whatsapp').forEach(el => {
    el.href = `https://wa.me/${CONFIG.whatsapp}?text=${waMsg}`;
  });
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

    // Loading state
    const submitBtn = form.querySelector('.btn-submit');
    submitBtn.classList.add('loading');
    submitBtn.disabled = true;

    setTimeout(() => {
      submitBtn.classList.remove('loading');
      submitBtn.disabled = false;

      const name     = nameEl.value.trim();
      const room     = roomEl.value;
      const checkIn  = checkInEl.value;
      const checkOut = checkOutEl.value;
      const nights   = Math.max(1, Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000));
      const price    = room === 'deluxe' ? 30000 : 20000;
      const total    = nights * price;
      const roomLabel = room === 'deluxe' ? 'Deluxe Room' : 'Standard Room';

      // Auto-open WhatsApp with booking details
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
      window.open(`https://wa.me/${CONFIG.whatsapp}?text=${waMsg}`, '_blank');

      form.style.display = 'none';
      showSuccess({ name, room, checkIn, checkOut }, CONFIG);
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