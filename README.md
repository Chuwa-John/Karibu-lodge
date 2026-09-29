# Karibu Lodge

The lodge's website and its booking system. Six rooms in Tegeta-kibaoni, Dar es
Salaam: guests pick an actual room number, it is held for them, and reception
sees it arrive.

**Live:** https://karibu-lodge.vercel.app — the reception console is at `/staff`.

---

## How a booking works

1. A guest picks dates, sees which of the six rooms are genuinely free, and
   picks one. They are signed in anonymously; no account, no password.
2. The room is **held for two hours**. The hold exists so a room is not kept
   all day for somebody who never turns up.
3. Reception sees the request the moment it lands, and the bell rings until
   somebody deals with it.
4. Reception confirms, declines, or — for a guest who phones to say they are on
   their way — presses **Hold longer**.

### Paying to keep a room

Two hours is the rule. Paying is the way out of it, and it is done by hand:
nothing here talks to a bank.

1. The guest pays the full amount to the lodge's M-Pesa Lipa number on their
   own phone, then taps **I have paid** and types the reference from the
   payment message.
2. That is a **claim, not a confirmation**. It cannot confirm the booking and
   cannot name its own figure — the rules force the claim to match the total
   already on the booking. What it does do is restart the hold, so the room is
   not resold while somebody checks.
3. Reception's console rings with a **louder, four-tone bell** that outranks
   every other alert, and the row shows 💰 with the reference.
4. Reception looks at the money on their own phone and answers: **Payment
   received** confirms the booking outright with no expiry, or **Not in my
   phone** leaves it pending on its ordinary hold so the guest can pay or
   correct the reference. Both go on the record.

> The till is registered to a different name from the lodge, so the page says
> so before the guest pays. A stranger asked for 30,000 TSH to a name they do
> not recognise will stop, and they are right to.

### Rooms and rates

| Rooms | Type | Rate |
|---|---|---|
| 1, 4, 6 | Deluxe — AC, TV, private toilet | 30,000 TSH/night |
| 2, 3, 5 | Standard — fan, private toilet | 20,000 TSH/night |

Rates live in the database, not the code. The owner changes them in the console
under **Rooms**; bookings already made keep the price they were made at.

---

## The idea that holds it together

Availability is a **night-cell ledger**: one document per room per night, at
`nights/{roomId}_{YYYY-MM-DD}`. Claiming a stay means creating every one of
those documents inside a single Firestore transaction.

**Why, and please do not "simplify" this:** the client SDK cannot run a query
inside a transaction, so an overlap query against a bookings collection has a
race between the read and the write that nothing on the client can close.
Addressing availability by document key is what makes double-booking
impossible. It also keeps the ledger free of personal data, so availability is
world-readable while bookings stay staff-only.

Two consequences worth knowing:

- **Hold expiry needs nothing to run.** The expiry is written onto each night
  cell, and a lapsed cell simply stops blocking. There is no scheduled job,
  and **v1 uses no Cloud Functions at all.**
- **Every staff action writes its audit entry inside the same transaction as
  the change**, so the record can never disagree with what happened.

### Who can do what

| | Guest | Reception | Owner |
|---|---|---|---|
| See what is free | ✅ | ✅ | ✅ |
| Book a room, say they paid | ✅ | ✅ | ✅ |
| Read their own booking | ✅ | ✅ | ✅ |
| Read anyone else's booking | ❌ | ✅ | ✅ |
| Confirm, decline, check in/out | ❌ | ✅ | ✅ |
| Change prices, take a room off sale | ❌ | ❌ | ✅ |
| Read the audit record | ❌ | ❌ | ✅ |

Roles are custom claims on the Auth token, so `firestore.rules` checks them
without an extra read. The rules are the real enforcement; hiding a tab is only
a convenience.

A visitor may hold at most **3 rooms per rolling two hours**, counted in
`webHolds/{uid}` and written in the same commit as the booking, so the count
cannot be skipped. Cancelling does not hand one back: it limits how often rooms
leave sale, not how many are live.

---

## Running it locally

Requires Node and Java 17 (the Firestore emulator needs a JDK).

```bash
npm install
npm run emu
```

That starts the emulators — Firestore on **8081**, Auth on **9098**, hosting on
**5002**, the emulator UI on **4401**. Deliberately not the Firebase defaults,
because another project on the same machine uses 8080/9099.

Then, in a second terminal:

```bash
npm run seed          # the six rooms; safe to re-run, keeps edited rates
npm run seed -- --force   # ...unless you want rates reset to defaults
```

Open **http://127.0.0.1:5002** for the guest site and **/staff** for reception.

> The site must be **served over http**. Opening `index.html` as a file does
> not work: ES modules are blocked by CORS on `file://` origins, so no
> JavaScript runs at all and every page renders stacked on top of the others.

`localhost` and `127.0.0.1` always talk to the emulator; any other hostname
talks to the real project. That switch is in `js/lib/env.js` and needs no flag.

### Tests

```bash
npm test
```

285 tests. Most are pure and need nothing running; the rules, availability and
admin suites need `npm run emu` first. They run with security rules **enabled**
and real guest/staff contexts, so a pass means the whole path works, not just
the JavaScript.

---

## Configuration

Almost everything the owner might change is in **`js/config.js`**: phone,
WhatsApp, address, images, the map, the M-Pesa till, and reception's own line.

```js
liveBooking: true,   // false → the booking page is the WhatsApp form only
```

That is the kill switch. Flip it to `false` and the site falls back to the
WhatsApp form it used before, with nothing else touched. Blanking the till
number back to `REPLACE_ME` switches off the pay-to-hold offer the same way.

**`js/lib/env.js`** holds the Firebase project config and the App Check site
key. Those values are public by design — they ship inside the page and identify
the project. What protects the data is `firestore.rules`.

### Staff accounts

Create the sign-in in the Firebase console first (Authentication → Users → Add
user), then grant the role:

```bash
FIRESTORE_TARGET=live GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
  node scripts/set-role.js reception@karibu.co.tz reception "Reception"
```

Roles are `reception`, `admin`, or `none` to revoke. A revoked token stops
working within the hour — that hour is the honest limit, because the rules read
the role from the token. The user must sign out and back in for a new role to
take effect.

---

## Language

The site is translated by **Google Translate** (English ⇄ Kiswahili, switch in
the navbar), not by a translation system of our own. One copy of every string
means no second copy to drift out of date.

Two exceptions live in **`js/lib/lang.js`**, written out in both languages:
the **payment step** and the **availability line**. Google only reaches what
the page renders later after a delay of tens of seconds, and — measured — it
rendered *"4 of 6 rooms free"* as *"vyumba 4 kati ya 6 bila malipo"*: four
rooms at no charge. Anything a human must read back exactly — till number,
booking reference, phone number, the name on the till — is marked
`translate="no"` where it is built.

---

## Deploying

**The site** is on Vercel, built from `main`. Pushing `main` deploys
production. `vercel.json` sets the build (`node scripts/build-site.js` → `dist`)
and the headers; the build publishes only the site, never tests, scripts or
rules.

**The rules and indexes** are deployed separately, and must go out before any
code that depends on them:

```bash
npx firebase deploy --only firestore:rules,firestore:indexes
```

`firebase.json`'s hosting section only serves the local emulator, which applies
no headers at all — production headers live in `vercel.json` and can only be
confirmed with `curl -I` against the live site.

### If something goes wrong

Set `liveBooking: false` in `js/config.js` and push. The booking system goes
dark, the WhatsApp form returns, and nothing else changes. It is one line, and
it does not touch the database, the rules, or anything already booked.

---

## Layout

```
index.html, staff.html     the guest site and the reception console
css/                       base, components, layout, pages, staff,
                           responsive.css — which MUST load last
js/
  config.js                everything the owner might edit
  main.js router.js ui.js  the static site
  booking.js               the WhatsApp form, and the loader for live booking
  guest-booking.js         picking a room, holding it, saying you paid
  staff.js admin-ui.js     the reception console and the owner's tabs
  lib/
    availability.js        the allocation engine — all of double-booking lives here
    dates.js rooms.js      nights, keys, the six rooms
    firebase.js env.js     which Firebase to talk to
    alerts.js chime.js     what the desk is told about, and the bell
    audit.js admin.js      the record; reports, prices, staff
    ask.js errors.js       in-page dialogs; failures in plain words
    lang.js               the strings we write ourselves, in both languages
scripts/                   seed, set-role, build-site
tests/                     18 suites
firestore.rules            the real enforcement
```

### Two rules that look odd and are not

- **`css/responsive.css` must stay last.** Breakpoint rules only win if they
  come after what they override. A test guards it, because this broke silently
  once already.
- **Never `window.confirm` or `window.prompt`.** A browser can suppress a
  native dialog and answer on the user's behalf, which turns *Decline* into a
  silent no-op. Use `askConfirm()` / `askText()` from `js/lib/ask.js`.
