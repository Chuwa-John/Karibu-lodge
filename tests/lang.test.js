// tests/lang.test.js — the strings this app writes itself, in both languages.
// Pure: no browser, no emulator.
//
// Google Translate handles the rest of the site. These are the ones it cannot
// be trusted with: the payment step, where a guest sends real money to a till
// in somebody else's name, and the availability line, which Google rendered
// as "vyumba 4 kati ya 6 BILA MALIPO" — four rooms at no charge.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chosenLanguage, words, STRING_KEYS } from '../js/lib/lang.js';

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

describe('the wording', () => {
  const vars = {
    amount: '20,000', provider: 'M-Pesa (Vodacom)', till: '353231650',
    room: '3', name: 'Leonia Paschal Matingo Store 2', phone: '0712345678',
    desk: '0761393333', free: 4, total: 6, stay: 'usiku 1', n: 1,
  };
  const render = (book, key) => {
    const v = book[key];
    return typeof v === 'function' ? v(vars) : v;
  };

  test('every string exists in Kiswahili as well as English', () => {
    const sw = words('sw');
    const en = words('en');
    const missing = STRING_KEYS.filter(k => render(sw, k) === render(en, k));
    assert.deepEqual(missing, [], 'these are still showing the English text');
  });

  test('an unknown language falls back to English rather than nothing', () => {
    const fr = words('fr');
    for (const key of STRING_KEYS) assert.ok(render(fr, key), `${key} came back empty`);
    assert.equal(render(fr, 'payButton'), 'I have paid');
  });

  test('the money and the till number survive translation word for word', () => {
    // The whole point. A mistyped or reworded till number sends 20,000 TSH to
    // nobody at all.
    for (const lang of ['en', 'sw']) {
      const w = words(lang);
      const how = render(w, 'payHow');
      assert.match(how, /353231650/, `${lang}: the till number, exactly`);
      assert.match(how, /20,000/, `${lang}: the amount, exactly`);
      assert.match(how, /M-Pesa \(Vodacom\)/, `${lang}: a name, not a word to translate`);

      assert.match(render(w, 'payName'), /Leonia Paschal Matingo Store 2/,
        `${lang}: the name on the till must not be reworded`);
      assert.match(render(w, 'thanksBody'), /0712345678/, `${lang}: the guest's own number`);
      assert.match(render(w, 'claimFailed'), /0761393333/, `${lang}: the desk's number`);
    }
  });

  describe('what "free" means', () => {
    test('English says available, never free — that is what Google misread', () => {
      const en = words('en');
      assert.match(render(en, 'roomsFree'), /available/);
      assert.doesNotMatch(render(en, 'roomsFree'), /\bfree\b/i,
        '"free" also means costing nothing, which is how this went wrong');
      assert.doesNotMatch(render(en, 'checking'), /\bfree\b/i);
    });

    test('Kiswahili says the rooms are open, not that they cost nothing', () => {
      const sw = words('sw');
      const line = render(sw, 'roomsFree');
      assert.match(line, /wazi/, 'wazi = open/vacant');
      assert.doesNotMatch(line, /bila malipo/i,
        'bila malipo = at no charge. This is the bug this whole module exists for.');
      assert.match(line, /Vyumba 4 kati ya 6/, 'the counts read naturally in Swahili');
    });

    test('a full house reads as booked in both languages', () => {
      assert.match(render(words('en'), 'allBooked'), /booked/);
      assert.match(render(words('sw'), 'allBooked'), /vimechukuliwa/);
    });

    test('nights are counted in the right language', () => {
      assert.equal(words('en').nights({ n: 1 }), '1 night');
      assert.equal(words('en').nights({ n: 3 }), '3 nights');
      assert.equal(words('sw').nights({ n: 3 }), 'usiku 3');
    });
  });

  test('the Kiswahili really is Kiswahili, not English with a coat of paint', () => {
    const sw = words('sw');
    assert.match(render(sw, 'payButton'), /Nimelipa/);
    assert.match(render(sw, 'thanksLead'), /Asante/);
    assert.match(render(sw, 'payHow'), /Lipa namba/);
    assert.match(render(sw, 'callButton'), /Piga mapokezi/);
    assert.match(render(sw, 'tryAgain'), /Jaribu tena/);
  });

  test('a missing variable does not leave the sentence half-written', () => {
    const how = words('sw').payHow({ amount: '20,000', till: '353231650', room: '3' });  // no provider
    assert.doesNotMatch(how, /undefined/);
    assert.match(how, /353231650/);
  });
});
