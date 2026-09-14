// A hyphenated card number matched nothing, so every One Piece card was
// priced from whatever else came back.
//
// Every title here was returned live by eBay on 2026-09-05 for a BGS 9.5
// Portgas.D.Ace OP13-119 SEC — the Manga Art secret rare, scanned off a real
// slab (cert 0019520243). Three of them are that card. The rest are OP13-002,
// a LEADER alt art from the same set, and EB02-028, a different set entirely.
//
// `numberInTitle` built its target by stripping punctuation — "OP13-119"
// became "OP13119" — but tokenised the TITLE with /[A-Z]*\d[A-Z0-9]*/, which
// breaks on the hyphen and can only ever yield "OP13" and "119". No token
// could equal the target, so the filter matched zero listings, declined to
// apply itself, and left OP13-002 and EB02-028 in the pool. The cheapest of
// those was a 91-day-old $54.99 ask, which then became the stale ceiling and
// capped the median.
//
// Result on the phone: a slab whose genuine comparables sit at $100-$200 was
// priced at $20.75. Every hyphenated id is affected, which is all of One Piece
// and all of Digimon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { numberInTitle } from "../src/scans/ebaylistings.js";

const WANT = "OP13-119";

const OURS = [
  "Portgas D Ace OP13-119 SEC Manga Jpn One Piece Carrying On His Will BGS 9.5",
  "2025 One Piece Carrying On His Will #OP13-119 Portgas D Ace Secret BGS 9.5",
  // Sellers write the same id with a space as often as a hyphen.
  "ONE PIECE OP13 119 CARRYING ON HIS WILL PORTGAS D ACE SEC BGS 9.5",
  // ...and sometimes with neither.
  "One Piece OP13119 Portgas D Ace Secret Rare BGS 9.5",
];

const NOT_OURS = [
  "ONE PIECE OP13 002 CARRYING ON HIS WILL PORTGAS D ACE LEADER ALT ART BGS 9.5",
  "2025 ONE PIECE CARRYING ON HIS WILL ALT ART L #OP13-002 PORTGAS D. ACE BGS 9.5",
  "One Piece Portgas D. Ace SP EB02-028 Alt Art Carrying On His Will BGS 9.5",
  // Same tail, different set prefix. The tail alone is not an identity.
  "One Piece Portgas D Ace EB01-119 Alt Art BGS 9.5",
];

test("a hyphenated id matches the card it names", () => {
  for (const t of OURS) {
    assert.equal(numberInTitle(t, WANT), true, `should keep: ${t}`);
  }
});

test("it does not match a different card from the same set", () => {
  for (const t of NOT_OURS) {
    assert.equal(numberInTitle(t, WANT), false, `should drop: ${t}`);
  }
});

test("the whole id has to match, not the half of it that is a set code", () => {
  // OP13 is the set. Matching on it would keep all 12 listings and price a
  // secret rare from a leader card.
  assert.equal(numberInTitle("ONE PIECE OP13 BOOSTER BOX SEALED", WANT), false);
});

test("Pokemon numbering still works", () => {
  // The path that was already right must stay right.
  assert.equal(numberInTitle("Charizard 4/102 Base Set Holo", "4"), true);
  assert.equal(numberInTitle("Meganium 010/132 Mega Evolution", "010"), true);
  assert.equal(numberInTitle("Meganium 010/132 Mega Evolution", "132"), false,
    "a denominator is not the card's number");
  assert.equal(numberInTitle("Mega Meganium ex 272/217 Ascended Heroes", "010"), false);
});

test("a leading zero is not a different card", () => {
  assert.equal(numberInTitle("Portgas D Ace OP13-119 SEC", "OP13-0119"), true);
  assert.equal(numberInTitle("Meganium 10/132", "010"), true);
});
