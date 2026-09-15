// tests/lang.test.js — the Kiswahili the payment step is written in.
// Pure: no browser, no emulator.
//
// Google Translate handles the rest of the site, but it never sees what this
// app renders after it has run, and the payment step is where a guest is
// asked to send real money to a till in somebody else's name. So those
// strings live in js/lib/lang.js in both languages, and these tests exist to
// stop the two drifting apart.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chosenLanguage, payWords, PAY_KEYS } from '../js/lib/lang.js';

describe('which language the visitor picked', () => {
  test('reads the cookie the Google switch writes', () => {
    assert.equal(chosenLanguage('googtrans=/en/sw'), 'sw');
    assert.equal(chosenLanguage('googtrans=/en/en'), 'en');
    assert.equal(chosenLanguage('foo=1; googtrans=/en/sw; bar=2'), 'sw', 'among other cookies');
    assert.equal(chosenLanguage('googtrans=/auto/sw-TZ'), 'sw', 'a regional variant is still Swahili');
  });

  test('anything it cannot read means English, never blank', () => {
    for (const cookie of ['', null, undefined, 'unrelated=1', 'googtrans=', 'googtrans=/en/fr']) {
      assert.equal(chosenLanguage(cookie), 'en', `cookie: ${cookie}`);
    }
  });
});

describe('the payment wording', () => {
  const vars = {
    amount: '20,000', provider: 'M-Pesa (Vodacom)', till: '353231650',
    room: '3', name: 'Leonia Paschal Matingo Store 2', phone: '0712345678', desk: '0761393333',
  };
  const render = (words, key) => {
    const v = words[key];
    return typeof v === 'function' ? v(vars) : v;
  };

  test('every string exists in Kiswahili as well as English', () => {
    const sw = payWords('sw');
    const missing = PAY_KEYS.filter(k => render(sw, k) === render(payWords('en'), k));
    assert.deepEqual(missing, [], 'these are still showing the English text');
  });

  test('an unknown language falls back to English rather than nothing', () => {
    const fr = payWords('fr');
    for (const key of PAY_KEYS) {
      assert.ok(render(fr, key), `${key} came back empty`);
    }
    assert.equal(render(fr, 'payButton'), 'I have paid');
  });

  test('the money and the till number survive translation word for word', () => {
    // The whole point. A mistyped or "translated" till number sends a guest's
    // 20,000 TSH to nobody.
    for (const lang of ['en', 'sw']) {
      const w = payWords(lang);
      const how = render(w, 'payHow');
      assert.match(how, /353231650/, `${lang}: the till number must appear exactly`);
      assert.match(how, /20,000/, `${lang}: the amount must appear exactly`);
      assert.match(how, /M-Pesa \(Vodacom\)/, `${lang}: the provider is a name, not a word to translate`);
      assert.match(how, /3/, `${lang}: the room number must appear`);

      assert.match(render(w, 'payName'), /Leonia Paschal Matingo Store 2/,
        `${lang}: the name on the till is a name and must not be reworded`);
      assert.match(render(w, 'thanksBody'), /0712345678/, `${lang}: the guest's own number`);
      assert.match(render(w, 'claimFailed'), /0761393333/, `${lang}: the desk's number`);
    }
  });

  test('the Kiswahili really is Kiswahili, not English with a coat of paint', () => {
    const sw = payWords('sw');
    assert.match(render(sw, 'payButton'), /Nimelipa/);
    assert.match(render(sw, 'thanksLead'), /Asante/);
    assert.match(render(sw, 'payHow'), /Lipa namba/);
    assert.match(render(sw, 'callButton'), /Piga mapokezi/);
  });

  test('a missing variable does not leave the sentence half-written', () => {
    const w = payWords('sw');
    const how = w.payHow({ amount: '20,000', till: '353231650', room: '3' });   // no provider
    assert.doesNotMatch(how, /undefined/);
    assert.match(how, /353231650/);
  });
});
