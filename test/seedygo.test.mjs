// Yu-Gi-Oh into the catalogue - GM001-26.
//
// The thing these tests exist for: YGOPRODeck returns the SAME set code more
// than once per card, with a different rarity each time. One collector code,
// two products, and the gap between a Super Rare and a Starlight Rare of the
// same card is routinely three orders of magnitude. Storing one row per set
// code would collapse them - the Shadowless-priced-off-Unlimited failure in a
// different game's clothes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsFor, syntheticProductId } from "../src/catalog/seedygo.js";

// Trimmed from a real YGOPRODeck payload, 14 September.
const CARD = {
  id: 80181649,
  name: "A Case for K9",
  card_images: [{ image_url: "https://images.ygoprodeck.com/images/cards/80181649.jpg" }],
  card_prices: [{ tcgplayer_price: "0.19", cardmarket_price: "0.21" }],
  card_sets: [
    { set_name: "Justice Hunters", set_code: "JUSH-EN040", set_rarity: "Starlight Rare", set_price: "0" },
    { set_name: "Justice Hunters", set_code: "JUSH-EN040", set_rarity: "Super Rare", set_price: "0" },
  ],
};

test("one set code at two rarities is two printings", () => {
  const rows = rowsFor(CARD);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.rarity).sort(), ["Starlight Rare", "Super Rare"]);
  // and they must be distinguishable downstream, not just in memory
  assert.notEqual(rows[0].productId, rows[1].productId);
});

test("the collector code survives whole", () => {
  // Yu-Gi-Oh codes are compound and already unique within the game, unlike
  // Pokemon's "125/197" which loses its denominator.
  const rows = rowsFor(CARD);
  assert.equal(rows[0].numberKey, "JUSH-EN040");
  assert.equal(rows[0].number, "JUSH-EN040");
});

test("the same (code, rarity) twice is one product, not two", () => {
  const dupe = { ...CARD, card_sets: [...CARD.card_sets, CARD.card_sets[0]] };
  assert.equal(rowsFor(dupe).length, 2, "duplication on their side is not a second product");
});

test("a card with no printings is still a card", () => {
  const rows = rowsFor({ ...CARD, card_sets: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].setCode, null);
  assert.equal(rows[0].name, "A Case for K9");
});

test("a card with no name or no id is dropped", () => {
  assert.deepEqual(rowsFor({ ...CARD, name: "" }), []);
  assert.deepEqual(rowsFor({ ...CARD, id: null }), []);
});

test("synthetic product ids are stable, negative and distinct", () => {
  // Negative so they can never collide with a TCGplayer product id, however
  // large TCGplayer's ids grow - and visibly not a TCGplayer id to a person
  // reading a row by hand.
  const a = syntheticProductId("ygo", "80181649", "JUSH-EN040", "Super Rare");
  const b = syntheticProductId("ygo", "80181649", "JUSH-EN040", "Starlight Rare");
  assert.ok(a < 0 && b < 0);
  assert.notEqual(a, b);
  assert.equal(a, syntheticProductId("ygo", "80181649", "JUSH-EN040", "Super Rare"), "stable across runs");
  assert.ok(Number.isSafeInteger(a), "must survive JSON and the pg driver intact");
});

test("the card-level price is used when the per-set price is zero", () => {
  // Their set_price is almost always "0"; the card-level TCGplayer figure is
  // the one with a number in it.
  const rows = rowsFor(CARD);
  assert.equal(rows[0].marketUsd, 0.19);
});

test("a real per-set price wins over the card-level one", () => {
  const rows = rowsFor({
    ...CARD,
    card_sets: [{ set_name: "X", set_code: "X-EN001", set_rarity: "Secret Rare", set_price: "42.50" }],
  });
  assert.equal(rows[0].marketUsd, 42.5);
});
