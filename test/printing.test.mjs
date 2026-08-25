// Fixtures drawn from the real OP13-119 listing set — the case where one card
// number is four products asking $82 to $8,200.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readPrinting, comparePrinting, describePrinting } from "../src/scans/printing.js";

const card = readPrinting("Portgas.D.Ace SEC manga art");
card.language = "ja";

const MATCH = [
  "Portgas D Ace OP13-119 SEC Manga Jpn One Piece Carrying On His Will BGS 9.5",
  "Portgas.D.Ace OP13-119 SEC Manga Alt Art - (BGS 9.5 Gem Mint)",
  "Portgas.D.Ace Manga Art Sec OP13-119 One Piece Bgs 9.5 Gold",
];
const CONFLICT = [
  // different printing line entirely
  "Portgas.D.Ace (119) (Parallel) OP13-119 Carrying On His Will Foil BGS 9.5",
  "One Piece Portgas D. Ace Carrying on His Will Wanted SP OP13-119 BGS 9.5 GM",
  "One Piece Portgas.D. Ace Wanted Poster Error Alt Art OP13-119 BGS 9.5 English",
  // right art, wrong language — a genuinely different product
  "Portgas D. Ace Manga Alternative Art OP13-119 One Piece English BGS 9.5",
];
const UNKNOWN = [
  // says nothing about the printing; weak evidence, not wrong evidence
  "2025 One Piece Carrying On His Will #OP13-119 Portgas D Ace Secret BGS 9.5",
];

for (const t of MATCH) {
  test(`match: ${t.slice(0, 46)}`, () =>
    assert.equal(comparePrinting(card, readPrinting(t)), "match"));
}
for (const t of CONFLICT) {
  test(`conflict: ${t.slice(0, 46)}`, () =>
    assert.equal(comparePrinting(card, readPrinting(t)), "conflict"));
}
for (const t of UNKNOWN) {
  test(`unknown: ${t.slice(0, 46)}`, () =>
    assert.equal(comparePrinting(card, readPrinting(t)), "unknown"));
}

test("a card we cannot read a printing for never rejects a listing", () => {
  const blank = readPrinting("");
  for (const t of [...MATCH, ...CONFLICT, ...UNKNOWN]) {
    assert.notEqual(comparePrinting(blank, readPrinting(t)), "conflict");
  }
});

test("Pokemon printing splits are read the same way", () => {
  assert.equal(readPrinting("Charizard Base Set Shadowless PSA 8").family, "shadowless");
  assert.equal(readPrinting("Pikachu 1st Edition Jungle PSA 9").family, "1st");
  assert.equal(readPrinting("Umbreon Reverse Holo SWSH PSA 10").family, "reverse");
  // Unlimited vs Shadowless is exactly the trap this exists to stop, and both
  // are now modelled, so the pair is a flat conflict rather than a shrug
  assert.equal(
    comparePrinting(readPrinting("Charizard Shadowless"), readPrinting("Charizard Unlimited")),
    "conflict",
  );
});

test("alt art is a modifier, not a printing line", () => {
  // "Manga Alt Art" is ONE printing. If alt-art were a family it would collide
  // with manga and split a single product into two.
  const p = readPrinting("SEC Manga Alt Art");
  assert.equal(p.family, "manga");
  assert.deepEqual(p.modifiers, ["altart"]);
});

test("describePrinting names it for a reader", () => {
  assert.equal(
    describePrinting(readPrinting("OP13-119 SEC Manga Alt Art Jpn")),
    "Manga Art · Alt Art · Japanese",
  );
  assert.equal(describePrinting(readPrinting("just a card")), null);
});

test("Chinese printings are their own market", () => {
  // the same Stussy SP: $51-68 Chinese, $100-124 Japanese, $130-138 English
  const en = readPrinting("Stussy (SP) OP07-085 A Fist of Divine Speed Foil English");
  const zh = readPrinting("Stussy (SP Alt Art) OP07-085 SR A Fist of Divine Speed - Chinese");
  const ja = readPrinting("Stussy OP07-085 SP SR Parallel A Fist of Divine Speed Japanese");
  assert.equal(en.language, "en");
  assert.equal(zh.language, "zh");
  assert.equal(comparePrinting(en, zh), "conflict");
  assert.equal(comparePrinting(en, ja), "conflict");
});

test("SP is a treatment, and does not steal the wanted-poster line", () => {
  assert.equal(readPrinting("Stussy (SP Alt Art) OP07-085 SR").family, "sp");
  // "Wanted SP" is the wanted-poster printing, listed before SP for this reason
  assert.equal(readPrinting("Carrying on His Will Wanted SP OP13-119 BGS 9.5").family, "wanted");
  // a plain SR is NOT the SP treatment - $2 vs $130
  assert.equal(readPrinting("Stussy OP07-085 SR 500 Years in the Future English").family, null);
});

test("a booster box is not a booster pack", () => {
  // both are "1999 Jungle 1st Edition"; the boxes ask $4,750 and the packs $1,400
  const pack = readPrinting("1999 Pokemon Jungle Foil Pack 1st Edition Scyther PSA 10");
  const box  = readPrinting("1999 Pokemon Jungle 1st Edition Booster Box Sealed WOTC");
  assert.equal(pack.form, "pack");
  assert.equal(box.form, "box");
  assert.equal(comparePrinting(pack, box), "conflict");
  assert.equal(
    comparePrinting(pack, readPrinting("1999 Jungle 1st Edition Booster Pack Wigglytuff PSA 10")),
    "match",
  );
  // an ETB is a box, not a pack
  assert.equal(readPrinting("Pokemon Elite Trainer Box sealed").form, "box");
  // a single card names no form at all
  assert.equal(readPrinting("Charizard Base Set 4/102 PSA 9").form, null);
});

test("Unlimited is a printing, not the absence of one", () => {
  const first = readPrinting("1999 Pokemon Jungle Foil Pack 1st Edition Scyther PSA 10");
  const unl   = readPrinting("1999 Pokemon Jungle Pack Wigglytuff Unlimited PSA 10 GEM MINT");
  assert.equal(first.family, "1st");
  assert.equal(unl.family, "unlimited");
  // left unmatched, a 179-day-old Unlimited listing set the ceiling for a 1st Ed card
  assert.equal(comparePrinting(first, unl), "conflict");
});
