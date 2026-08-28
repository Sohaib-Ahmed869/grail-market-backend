// Beckett's 10 is two products and our sold-comp source publishes one key for
// both, so the only place the difference is visible to us is in what sellers
// write on eBay. That makes this parser load-bearing on a ~10x price gap, and
// "BLACK" is a dangerous word to match on in Pokemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelFromTitle } from "../src/scans/ebaylistings.js";

test("a Black Label is read as one", () => {
  for (const t of [
    "2025 Pokemon S&V Destined Rivals Team Rocket's Mewtwo ex #231 BGS 10 BLACK LABEL",
    "TEAM ROCKET'S MEWTWO EX SIR 2025 POKEMON SC&VI 231 BLACK LABEL BGS 10",
    "Pokemon Charizard BGS 10 Black Label Pristine",
    "Umbreon VMAX 215/203 BGS 10 BLACKLABEL",
  ]) {
    assert.equal(labelFromTitle(t), "black", t);
  }
});

test("a gold-label Pristine is not a Black Label", () => {
  for (const t of [
    "⭐️ BGS 10 Pristine Team Rocket's Mewtwo ex 231/182 Destined Rivals SIR ⭐️",
    "Pokemon Card Team Rockets Mewtwo EX 231/182 SIR Destined Rivals BGS 10 PRISTINE",
  ]) {
    assert.equal(labelFromTitle(t), "gold", t);
  }
});

// The traps. "Black" is everywhere in Pokemon and almost none of it is Beckett.
test("Pokemon's own uses of BLACK are not grading labels", () => {
  for (const t of [
    // a promo set — this one would have mispriced a huge number of cards
    "Mega Charizard X ex MEP Black Star Promos #023 BGS 10",
    "Pokemon Black Star Promo Pikachu BGS 9.5",
    // a set name
    "Pokemon Black Bolt 2025 Charizard BGS 10",
    // an era
    "Pokemon Black & White Base Set Reshiram BGS 9.5",
    "Black and White Emerging Powers BGS 10",
    // a third-party product, not a Beckett label — this one is in the live
    // listings panel for the very card that prompted all this
    "Pokemon Team Rocket's Mewtwo ex Destined Rivals MBA BLACK DIAMOND #231 BGS 10",
  ]) {
    assert.notEqual(labelFromTitle(t), "black", t);
  }
});

test("no label claim at all when the title says nothing", () => {
  assert.equal(labelFromTitle("Pokemon Charizard 4/102 BGS 9"), null);
  assert.equal(labelFromTitle("Team Rocket's Mewtwo ex 231/182 raw NM"), null);
});

test("a black label only counts on a 10 — Beckett does not issue any other", () => {
  assert.equal(labelFromTitle("Pokemon Charizard BGS 9.5 BLACK LABEL"), null);
});
