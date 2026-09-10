// The ways round the masker.
//
// Every rule in censor.js reads the shape of a phone number, and every one of
// them was blind to a person who wrote the same number in a different
// alphabet, in letters that look like digits, or four digits at a time across
// four messages. These pin the bypasses shut. Each one of them worked.
//
// The other half of this file matters more: a card marketplace is people
// typing long numbers all day, and a filter that eats "1986 Fleer 57" or
// "cert 82749113" is a filter that gets turned off in week one. Every
// legitimate case here must survive untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { censor } from "../src/community/censor.js";
import { weigh, loosePieces } from "../src/community/pressure.js";

const clean = (s) => censor(s).text;
const gone = (s) => !/\d{4}/.test(clean(s));

// ---- the same number, written in other alphabets ---------------------------

test("digits that are not ASCII digits", () => {
  for (const [what, n] of [
    ["fullwidth", "０４１２３４５６７８"],
    ["arabic-indic", "٠٤١٢٣٤٥٦٧٨"],
    ["extended arabic-indic", "۰۴۱۲۳۴۵۶۷۸"],
    ["devanagari", "०४१२३४५६७८"],
  ]) {
    assert.ok(gone(`call me ${n}`), `${what} survived: ${clean(`call me ${n}`)}`);
  }
});

test("emoji keycaps, and no stray decoration left behind", () => {
  const out = clean("0️⃣4️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣");
  assert.ok(!/\d/.test(out), out);
  // The keycap is a digit, a variation selector and a combining mark. Masking
  // only the digit leaves the other two on screen as rubbish.
  assert.ok(!/[⃣️]/.test(out), `decoration left behind: ${JSON.stringify(out)}`);
});

test("zero-width characters between the digits", () => {
  assert.ok(gone("04​12​345​678"));
  assert.ok(gone("0‍4‍1‍2‍3‍4‍5‍6‍7‍8"));
});

test("letters standing in for digits", () => {
  assert.ok(gone("O4I2 E45 G78"));
  assert.ok(gone("o4i2e45g78"));
});

test("a word that folds to seven digits is still a word", () => {
  // "beetles" is 8337135 under letter-for-digit substitution. A rule that
  // masks it is a rule that eats English.
  assert.equal(clean("the beetles cassettes are sealed"), "the beetles cassettes are sealed");
  assert.equal(clean("goose eggs and loose leaves"), "goose eggs and loose leaves");
});

test("numbers spelled out, in whatever language", () => {
  for (const n of [
    "oh four one two three four five six seven eight",
    "cero cuatro uno dos tres cuatro cinco seis siete ocho",
    "sifar char ek do teen char paanch chhe saat aath",
    "零四一二三四五六七八",
  ]) {
    const out = clean(n);
    assert.ok(out.includes("[contact removed]"), `survived: ${out}`);
  }
});

test("counting out loud is not a phone number", () => {
  assert.equal(
    clean("I have three of these and two of those"),
    "I have three of these and two of those",
  );
});

// ---- addresses -------------------------------------------------------------

test("an email with spaces around the punctuation", () => {
  for (const a of [
    "sohaib@gmail.com",
    "sohaib at gmail dot com",
    "sohaib @ gmail . com",
    "sohaib [at] gmail [dot] com",
  ]) {
    assert.ok(clean(`reach me ${a} thanks`).includes("[contact removed]"), a);
  }
});

test("naming a mail provider is flagged, not cut out of the sentence", () => {
  const r = censor("just search sohaib92 on gmail");
  assert.equal(r.text, "just search sohaib92 on gmail");
  assert.ok(r.hits.includes("mail-provider"));
});

// ---- a number split across messages ----------------------------------------

test("four messages, three digits at a time", () => {
  const said = [];
  const send = (m) => {
    const v = weigh(m, [...said].reverse());
    said.push(m);
    return v;
  };
  send("hey is this still available");
  assert.equal(send("my mobile starts 0412").masked, false);
  assert.equal(send("then 345").masked, false);
  // The one that completes the number is the one that does not go through.
  assert.equal(send("and ends 678").masked, true);
});

test("bare fragments, with nobody saying the word mobile", () => {
  const said = [];
  const send = (m) => {
    const v = weigh(m, [...said].reverse());
    said.push(m);
    return v;
  };
  for (const m of ["04", "12", "34", "56"]) send(m);
  assert.equal(send("78").masked, true);
});

test("haggling over prices never trips it", () => {
  const thread = [
    "I paid 12500 for it, will take 11800",
    "market says 12500 but I'd take 11000",
    "PSA cert 82749113 if you want to check",
    "it's Base Set 4 of 102, 1999 print",
    "BGS 9.5 with 10 centering",
  ];
  const said = [];
  for (const m of thread) {
    assert.equal(weigh(m, [...said].reverse()).masked, false, `masked: ${m}`);
    said.push(m);
  }
});

test("sports cards are long numbers all the way down", () => {
  const thread = [
    "1986 Fleer 57, the Jordan rookie",
    "2000 Bowman 236 Brady",
    "2018 Prizm 280 Luka",
    "graded PSA 9, cert 41883021",
    "asking 4200, will take 3900",
  ];
  const said = [];
  for (const m of thread) {
    assert.equal(weigh(m, [...said].reverse()).masked, false, `masked: ${m}`);
    said.push(m);
  }
});

test("an explained number contributes nothing to the score", () => {
  for (const m of [
    "PSA cert 82749113 on this one",
    "Base Set 4 of 102",
    "1999 first edition",
    "I paid 12500",
    "asking 4200",
  ]) {
    assert.equal(loosePieces(m).digits, 0, m);
  }
});
