// js/router.js

import { initReveal } from './ui.js';

const PAGES = {
  home:    'page-home',
  rooms:   'page-rooms',
  booking: 'page-booking',
  contact: 'page-contact',
};

 

export function navigate(page, push = true) {
  // Validate — silently fall back to home if unknown page
  if (!(page in PAGES)) page = 'home';

  // Hide all pages
  Object.values(PAGES).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Show target page
  const target = document.getElementById(PAGES[page]);
  if (!target) return;
  target.style.display = 'block';

  // Update active nav link
  document.querySelectorAll('[data-page]').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page);
  });

  // Update URL hash
  if (push) window.location.hash = page === 'home' ? '' : page;

   

  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Trigger reveal animations
  setTimeout(initReveal, 100);
}

export function initRouter() {
  // Handle browser back/forward
  window.addEventListener('hashchange', () => {
    const h = window.location.hash.replace('#', '') || 'home';
    navigate(h in PAGES ? h : 'home', false);
  });

  // Handle all [data-page] clicks
  document.addEventListener('click', e => {
    const link = e.target.closest('[data-page]');
    if (link) {
      e.preventDefault();
      navigate(link.dataset.page);
    }
  });
}