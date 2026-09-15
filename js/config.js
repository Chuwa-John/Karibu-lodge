// js/config.js
// ============================================
// ★  KARIBU LODGE — Edit everything here  ★
// ============================================

export const CONFIG = {

  // ── Contact ────────────────────────────
  phone:    "+254794422088",
  whatsapp: "254794422088",          // digits only, no + or spaces
  email:    "info@karibulodge.co.tz",
  address:  "Karibu Lodge, Tegeta-kibaoni, Tanzania",

  // ── Booking ────────────────────────────
  // true:  guests pick an actual room and it is held for them. Needs Firebase
  //        set up in js/lib/env.js — until then the site quietly uses WhatsApp.
  // false: the booking page is the WhatsApp form only. Flip this to switch
  //        live booking off at once, without touching any other code.
  liveBooking: true,

  // ── Payment ────────────────────────────
  // The mobile-money till a guest pays into to secure a room outright, instead
  // of having to reach the lodge within the two-hour hold. There is NO payment
  // gateway here and nothing on this site ever talks to a bank: the guest pays
  // on their own phone, tells the system they have paid and quotes the message
  // reference, reception checks their own phone, and only reception's
  // confirmation holds the room. Until `number` is filled in, the site does not
  // offer paying at all and the two-hour hold is the only way.
  till: {
    number:   "353231650",         // Vodacom M-Pesa Lipa number guests pay into
    provider: "M-Pesa (Vodacom)",  // so the guest knows which menu to use

    // What the guest's OWN phone shows when they confirm the payment. It is
    // not the lodge's name, so the page says so before they pay: a stranger
    // being asked for 20,000 TSH to a name they do not recognise will stop,
    // and they are right to.
    name: "Leonia Paschal Matingo Store 2",
  },

  // The desk. There is NO WhatsApp on this line, so anything that tells a
  // guest to get in touch after paying must say call, never message.
  receptionPhone: "0761393333",

  // ── Google Maps ────────────────────────
  mapEmbedUrl: "https://www.google.com/maps/embed?pb=!1m17!1m12!1m3!1d3962.8673972968845!2d39.17967717584115!3d-6.663350593331586!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m2!1m1!2zNsKwMzknNDguMSJTIDM5wrAxMCc1Ni4xIkU!5e0!3m2!1sen!2ske!4v1775203075201!5m2!1sen!2ske",

  // ── Images ─────────────────────────────
  images: {
    hero:      "assets/images/hero.jpg",
    standard1: "assets/images/room-standard.jpeg",
    standard2: "assets/images/room-standard.jpeg",
    deluxe1:   "assets/images/room-deluxe-alt.jpeg",
    deluxe2:   "assets/images/room-deluxe.jpeg",
    gallery1:  "assets/images/room-deluxe-alt.jpeg",
    gallery2:  "assets/images/room-standard.jpeg",
    gallery3:  "assets/images/room-deluxe.jpeg",
    gallery4:  "assets/images/reception-1.jpeg",
    gallery5:  "assets/images/reception-2.jpeg",
    gallery6:  "assets/images/hero.jpg",
  },

};