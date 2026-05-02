// js/main.js
// ============================================
// Boot — wires all modules together
// ============================================

import { CONFIG }                                    from './config.js';
import { navigate, initRouter }                      from './router.js';
import { applyConfig, initNavbar, initReveal, initLightbox } from './ui.js';
import { initBooking }                               from './booking.js';

document.addEventListener('DOMContentLoaded', () => {

  // 1. Apply all CONFIG values to the DOM
  applyConfig(CONFIG);

  // 2. Init navbar scroll + hamburger
  initNavbar();

  // 3. Init client-side router
  initRouter();

  // 4. Init booking form
  initBooking(CONFIG);

  // 5. Navigate to correct page from URL hash
  const hash = window.location.hash.replace('#', '') || 'home';
  navigate(hash, false);

  // 6. Init scroll reveal animations
  initReveal();

  // 7. Init gallery lightbox
  initLightbox();

  // 8. Mark body as ready (enables CSS transitions)
  document.body.classList.add('ready');

});