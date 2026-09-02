// Contact details in a public forum are how a marketplace gets hollowed out:
// two members agree a price in the open, move to WhatsApp, and every
// protection the platform offers — the ID check, the dispute path, the record
// that a trade happened at all — is gone. The scope document makes masking a
// launch requirement, so these pin what must never survive a post.
import { test } from "node:test";
import assert from "node:assert/strict";
import { censor, hasContact } from "../src/community/censor.js";

const clean = (s) => censor(s).text;

// ---- phone numbers ---------------------------------------------------------

test("Australian mobiles, however they are spaced", () => {
  for (const n of [
    "0412 345 678", "0412345678", "0412-345-678",
    "+61 412 345 678", "+61412345678", "(04) 1234 5678",
  ]) {
    const out = clean(`call me on ${n} thanks`);
    assert.ok(!/\d{6}/.test(out), `left digits behind: ${out}`);
    assert.match(out, /\[contact removed\]/);
  }
});

test("landlines and international numbers too", () => {
  assert.match(clean("ring 02 9876 5432"), /\[contact removed\]/);
  assert.match(clean("+1 415 555 0132"), /\[contact removed\]/);
});

test("a card number is not a phone number", () => {
  // the whole catalogue is numbers; masking them would make the forum useless
  for (const s of ["OP13-119", "Base Set 4/102", "PSA 10 cert 82749113",
                   "#215 alt art", "sold for 41500"]) {
    assert.equal(clean(s), s, `mangled a card reference: ${s}`);
  }
});

test("a year or a price survives", () => {
  assert.equal(clean("1999 Base Set, paid $3,950 in 2024"), "1999 Base Set, paid $3,950 in 2024");
});

// ---- emails ----------------------------------------------------------------

test("emails go, including the obvious dodges", () => {
  for (const e of [
    "me@example.com", "me (at) example.com", "me [at] example [dot] com",
    "me AT example DOT com",
  ]) {
    assert.match(clean(`email ${e}`), /\[contact removed\]/, `survived: ${e}`);
  }
});

// ---- handles and off-platform apps -----------------------------------------

test("an invitation to move off the platform is flagged", () => {
  assert.ok(hasContact("hit me up on whatsapp"));
  assert.ok(hasContact("my insta is @cardguy_au"));
  assert.ok(hasContact("dm me on telegram"));
});

test("ordinary talk is left alone", () => {
  for (const s of [
    "the centering is off on the left",
    "I paid 300 for mine last year",
    "PSA turnaround is 42 days",
    "grading it costs more than the card",
  ]) {
    assert.equal(clean(s), s);
    assert.equal(hasContact(s), false, `false positive: ${s}`);
  }
});

// ---- what the caller gets back ---------------------------------------------

test("the result says whether anything was removed", () => {
  const a = censor("nice pull");
  assert.equal(a.masked, false);
  assert.equal(a.text, "nice pull");

  const b = censor("txt 0412 345 678");
  assert.equal(b.masked, true);
  assert.ok(b.hits.includes("phone"));
});

// ---- the shape the store relies on -----------------------------------------

test("a post keeps its meaning after masking", () => {
  const r = censor(
    "Selling my PSA 10 Base Set Charizard 4/102, cert 82749113. " +
    "Text me on 0412 345 678 or email me@example.com",
  );
  assert.equal(r.masked, true);
  assert.match(r.text, /PSA 10 Base Set Charizard 4\/102/);
  assert.match(r.text, /cert 82749113/);
  assert.ok(!/0412/.test(r.text));
  assert.ok(!/example\.com/.test(r.text));
  assert.deepEqual([...r.hits].sort(), ["email", "phone"]);
});

test("masking is idempotent — running it twice changes nothing", () => {
  const once = censor("call 0412 345 678").text;
  assert.equal(censor(once).text, once);
});
