// js/lib/lang.js
//
// The strings this app writes itself, in English and Kiswahili.
//
// The site at large is translated by Google Translate (see the foot of
// index.html): one copy of every string, translated in place, no language
// control of our own. That is the right trade for a brochure. It is the wrong
// trade for two things:
//
//   1. Money. A guest is asked to send real shillings to a till registered in
//      somebody else's name. Those words have to be exact.
//   2. Availability. Measured 2026-09-15: Google rendered "4 of 6 rooms free"
//      as "Vyumba 4 kati ya 6 BILA MALIPO" — four rooms at no charge. A lodge
//      cannot have its booking page saying that.
//
// So those few strings live here in both languages, chosen by the SAME Google
// switch (it leaves a googtrans cookie behind), and the elements that show
// them are marked translate="no" so Google does not translate our Swahili
// into Swahili again.
//
// Deliberately small. Every string here is one that can drift from its twin.

/** What the Google widget stores when someone picks a language: googtrans=/en/sw */
export function chosenLanguage(cookie) {
  const raw = cookie ?? (typeof document === 'undefined' ? '' : document.cookie);
  const m = /googtrans=\/[a-z-]+\/([a-z-]+)/i.exec(String(raw || ''));
  const lang = m ? m[1].toLowerCase() : 'en';
  return lang.startsWith('sw') ? 'sw' : 'en';
}

const EN = {
  /* ── What is free, and when ──────────────────────────────────── */
  // "available", never "free": free also means costing nothing, and that is
  // exactly the reading Google picked when this said free.
  checking:    'Checking which rooms are available…',
  roomsFree:   ({ free, total, stay }) => `${free} of ${total} rooms available for ${stay}.`,
  allBooked:   ({ stay }) => `Every room is booked for ${stay}. Try other dates, or message us.`,
  cannotCheck: 'We could not check availability just now.',
  tryAgain:    'Try again',
  nights:      ({ n }) => `${n} night${n === 1 ? '' : 's'}`,
  // Shown in the same element, which Google is told to leave alone — so these
  // have to be here too, or they would sit in English inside a Swahili page.
  pickDates:     'Choose your check-in and check-out dates.',
  pastCheckIn:   'Check-in cannot be in the past.',
  checkOutAfter: 'Check-out must be after check-in.',
  tooLong:       ({ max }) => `For stays longer than ${max} nights, please message us.`,

  /* ── Paying the till ─────────────────────────────────────────── */
  payLead:      'Arriving later than that?',
  payHow:       ({ amount, provider, till, room }) =>
    `Pay the full ${amount} TSH${provider ? ` by ${provider}` : ''} to Lipa number ${till}, then tell us ` +
    `below. Reception checks the payment on their own phone and keeps Room ${room} for you — no two-hour limit.`,
  payName:      ({ name }) =>
    `The till is registered as ${name}. That is us — your phone will show that name, ` +
    'not Karibu Lodge, when you confirm the payment.',
  refLabel:     'Reference from your payment message',
  refPlaceholder: 'e.g. QWE4RT56YU',
  payButton:    'I have paid',
  payWorking:   'Telling reception…',
  refMissing:   'Please copy the reference from the payment message on your phone.',
  thanksLead:   'Thank you — reception is checking your payment now.',
  thanksBody:   ({ phone, room }) =>
    `They will call you on ${phone} once they see it. Room ${room} is being kept for you in the meantime.`,
  callButton:   '📞 Call reception',
  claimFailed:  ({ desk }) =>
    `We could not pass that on just now. Please call reception${desk ? ` on ${desk}` : ''} and read them your reference.`,
  roomGone:     'Sorry — that room has just been taken. Please choose another, or call reception.',
};

const SW = {
  checking:    'Tunaangalia vyumba vilivyo wazi…',
  roomsFree:   ({ free, total, stay }) => `Vyumba ${free} kati ya ${total} vipo wazi kwa ${stay}.`,
  allBooked:   ({ stay }) =>
    `Vyumba vyote vimechukuliwa kwa ${stay}. Jaribu tarehe nyingine, au wasiliana nasi.`,
  cannotCheck: 'Hatukuweza kuangalia nafasi kwa sasa.',
  tryAgain:    'Jaribu tena',
  nights:      ({ n }) => `usiku ${n}`,
  pickDates:     'Chagua tarehe ya kuingia na ya kutoka.',
  pastCheckIn:   'Tarehe ya kuingia haiwezi kuwa iliyopita.',
  checkOutAfter: 'Tarehe ya kutoka lazima iwe baada ya tarehe ya kuingia.',
  tooLong:       ({ max }) => `Kwa kukaa zaidi ya usiku ${max}, tafadhali wasiliana nasi.`,

  payLead:      'Utafika baada ya saa mbili?',
  payHow:       ({ amount, provider, till, room }) =>
    `Lipa kiasi kamili cha TSH ${amount}${provider ? ` kwa ${provider}` : ''} kwenda Lipa namba ${till}, ` +
    `kisha tujulishe hapa chini. Mapokezi watathibitisha malipo kwenye simu yao na watakuwekea ` +
    `Chumba ${room} — bila kikomo cha saa mbili.`,
  payName:      ({ name }) =>
    `Lipa namba hii imesajiliwa kwa jina la ${name}. Ni sisi — simu yako itaonyesha jina hilo, ` +
    'siyo Karibu Lodge, utakapothibitisha malipo.',
  refLabel:     'Kumbukumbu (reference) kutoka ujumbe wa malipo',
  refPlaceholder: 'mfano QWE4RT56YU',
  payButton:    'Nimelipa',
  payWorking:   'Tunawajulisha mapokezi…',
  refMissing:   'Tafadhali nakili kumbukumbu kutoka ujumbe wa malipo uliopo kwenye simu yako.',
  thanksLead:   'Asante — mapokezi wanahakiki malipo yako sasa.',
  thanksBody:   ({ phone, room }) =>
    `Watakupigia simu kwa ${phone} mara watakapoyaona. Chumba ${room} kinawekwa kwa ajili yako kwa muda huo.`,
  callButton:   '📞 Piga mapokezi',
  claimFailed:  ({ desk }) =>
    `Hatukuweza kutuma taarifa hiyo kwa sasa. Tafadhali piga mapokezi${desk ? ` kwa ${desk}` : ''} ` +
    'na uwasomee kumbukumbu yako.',
  roomGone:     'Samahani — chumba hicho kimechukuliwa hivi punde. Tafadhali chagua kingine, au piga mapokezi.',
};

const BOOKS = { en: EN, sw: SW };

/**
 * The wording for a language. A key missing from a book falls back to English
 * rather than coming back blank: a half-written payment instruction is worse
 * than one in the wrong language.
 */
export function words(lang = 'en') {
  const book = BOOKS[lang] || EN;
  return new Proxy({}, { get: (_, key) => book[key] ?? EN[key] });
}

/** Every key, so a translation missed here fails a test rather than a guest. */
export const STRING_KEYS = Object.keys(EN);
