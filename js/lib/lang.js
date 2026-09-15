// js/lib/lang.js
//
// Kiswahili for the money.
//
// The site itself is translated by Google Translate (see the foot of
// index.html): one copy of every string, translated in place. But Google only
// ever sees the markup that was on the page when it ran. Anything this app
// renders afterwards — the room list, the hold countdown, and the payment
// card — stays in English however the switch is set. Measured 2026-09-15:
// with the page in Swahili, the booking widget still read "Room 1 · 30,000
// TSH / night" and "4 of 6 rooms free".
//
// That is tolerable for a room list and not tolerable for the payment step: a
// guest is being asked to send real money to a till registered under somebody
// else's name. Those few strings are therefore kept here in both languages,
// chosen by the SAME Google switch, so there is still no language control of
// our own to keep in step with it.
//
// Deliberately small. Every string added here is a string that can drift from
// its English twin, so this covers paying and nothing else.

/** What the Google widget stores when someone picks a language: googtrans=/en/sw */
export function chosenLanguage(cookie) {
  const raw = cookie ?? (typeof document === 'undefined' ? '' : document.cookie);
  const m = /googtrans=\/[a-z-]+\/([a-z-]+)/i.exec(String(raw || ''));
  const lang = m ? m[1].toLowerCase() : 'en';
  return lang.startsWith('sw') ? 'sw' : 'en';
}

const EN = {
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
 * The payment wording for a language. Missing keys fall back to English
 * rather than showing a blank: a half-empty payment instruction is worse than
 * one in the wrong language.
 */
export function payWords(lang = 'en') {
  const book = BOOKS[lang] || EN;
  return new Proxy({}, {
    get(_, key) {
      const value = book[key] ?? EN[key];
      return typeof value === 'function' ? value : value;
    },
  });
}

/** Every key the payment step needs, so a missing translation is a test failure. */
export const PAY_KEYS = Object.keys(EN);
