// js/ui.js

/* ── Reveal (Intersection Observer) ── */
export function initReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('visible');
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  els.forEach(el => io.observe(el));
}

/* ── Navbar ── */
export function initNavbar() {
  const navbar      = document.getElementById('navbar');
  const hamburger   = document.getElementById('hamburger');
  const mobileNav   = document.getElementById('mobile-nav');
  const mobileClose = document.getElementById('mobile-close');

  if (!navbar) return;

  // Scroll shadow
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 40);
  }, { passive: true });

  // Hamburger open/close
  if (hamburger && mobileNav) {
    hamburger.addEventListener('click', () => {
      const isOpen = mobileNav.classList.toggle('open');
      hamburger.classList.toggle('active', isOpen);
      document.body.style.overflow = isOpen ? 'hidden' : '';
    });
  }

  // Mobile close button
  if (mobileClose && mobileNav) {
    mobileClose.addEventListener('click', () => {
      mobileNav.classList.remove('open');
      if (hamburger) hamburger.classList.remove('active');
      document.body.style.overflow = '';
    });
  }

  // Close mobile nav on any nav link click
  mobileNav?.querySelectorAll('[data-page]').forEach(link => {
    link.addEventListener('click', () => {
      mobileNav.classList.remove('open');
      if (hamburger) hamburger.classList.remove('active');
      document.body.style.overflow = '';
    });
  });
}

/* ── Lightbox ── */
export function initLightbox() {
  const lightbox      = document.getElementById('lightbox');
  const lightboxImg   = document.getElementById('lightbox-img');
  const lightboxClose = document.getElementById('lightbox-close');

  if (!lightbox) return;

  document.querySelectorAll('.gallery-item img').forEach(img => {
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => {
      lightboxImg.src = img.src;
      lightboxImg.alt = img.alt;
      lightbox.style.display = 'flex';
      document.body.style.overflow = 'hidden';
    });
  });

  function closeLightbox() {
    lightbox.style.display = 'none';
    document.body.style.overflow = '';
    lightboxImg.src = '';
  }

  lightbox.addEventListener('click', e => {
    if (e.target === lightbox) closeLightbox();
  });
  if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLightbox();
  });
}

/* ── Apply CONFIG to DOM ── */
export function applyConfig(CONFIG) {

  // Hero background image
  const heroBg = document.getElementById('img-hero');
  if (heroBg) {
    heroBg.style.backgroundImage = `url('${CONFIG.images.hero}')`;
    const img = new Image();
    img.onload = () => heroBg.classList.add('loaded');
    img.src = CONFIG.images.hero;
  }

  // Room and gallery images by ID
  const idMap = {
    'img-standard-1': CONFIG.images.standard1,
    'img-standard-2': CONFIG.images.standard2,
    'img-deluxe-1':   CONFIG.images.deluxe1,
    'img-deluxe-2':   CONFIG.images.deluxe2,
    'img-gallery-1':  CONFIG.images.gallery1,
    'img-gallery-2':  CONFIG.images.gallery2,
    'img-gallery-3':  CONFIG.images.gallery3,
    'img-gallery-4':  CONFIG.images.gallery4,
    'img-gallery-5':  CONFIG.images.gallery5,
    'img-gallery-6':  CONFIG.images.gallery6,
  };
  Object.entries(idMap).forEach(([id, src]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.src = src;
    el.onerror = () => {
      const wrap = el.closest('.room-img-wrap, .room-detail-img, .gallery-item');
      if (wrap) {
        el.style.display = 'none';
        wrap.style.background = 'linear-gradient(135deg, #9B7355, #6B4F3A)';
      }
    };
  });

  // data-img attribute elements
  Object.entries(CONFIG.images).forEach(([key, src]) => {
    document.querySelectorAll(`[data-img="${key}"]`).forEach(el => {
      if (el.tagName === 'IMG') el.src = src;
      else el.style.backgroundImage = `url('${src}')`;
    });
  });

  // Phone
  document.querySelectorAll('.cfg-phone').forEach(el => {
    el.textContent = CONFIG.phone;
    if (el.tagName === 'A') el.href = `tel:${CONFIG.phone}`;
  });

  // Email
  document.querySelectorAll('.cfg-email').forEach(el => {
    el.textContent = CONFIG.email;
    if (el.tagName === 'A') el.href = `mailto:${CONFIG.email}`;
  });

  // Address
  document.querySelectorAll('.cfg-address').forEach(el => {
    el.textContent = CONFIG.address;
  });

  // WhatsApp links
  document.querySelectorAll('.cfg-whatsapp').forEach(el => {
    const msg = encodeURIComponent(
      el.dataset.msg || "Hello! I'd like to enquire about Karibu Lodge."
    );
    el.href = `https://wa.me/${CONFIG.whatsapp}?text=${msg}`;
  });

  // Map iframe
  const mapFrame = document.getElementById('map-frame');
  if (mapFrame && CONFIG.mapEmbedUrl) {
    mapFrame.src = CONFIG.mapEmbedUrl;
    mapFrame.style.display = 'block';
    const placeholder = document.getElementById('map-placeholder');
    if (placeholder) placeholder.style.display = 'none';
  }

  // Footer icon links
  const fPhone = document.getElementById('footer-phone');
  if (fPhone) fPhone.href = `tel:${CONFIG.phone}`;

  const fEmail = document.getElementById('footer-email');
  if (fEmail) fEmail.href = `mailto:${CONFIG.email}`;

  const fPhoneLink = document.getElementById('footer-phone-link');
  if (fPhoneLink) {
    fPhoneLink.textContent = CONFIG.phone;
    fPhoneLink.href = `tel:${CONFIG.phone}`;
  }

  const fEmailLink = document.getElementById('footer-email-link');
  if (fEmailLink) {
    fEmailLink.textContent = CONFIG.email;
    fEmailLink.href = `mailto:${CONFIG.email}`;
  }

  // Contact page phone link
  const cPhoneLink = document.getElementById('contact-phone-link');
  if (cPhoneLink) cPhoneLink.href = `tel:${CONFIG.phone}`;

  const cEmailLink = document.getElementById('contact-email-link');
  if (cEmailLink) cEmailLink.href = `mailto:${CONFIG.email}`;

  // Year
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
}