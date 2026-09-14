// Filling in a card's finish from data we already hold — GM001-26.
//
// The trap this guards: the obvious join, catalog_cards.card_number =
// printings.number_key, is WRONG. Measured on the real catalogue,
// optcg-OP17-022 (Shanks) and optcg-OP17-022_p2 (Shanks, Manga) both match
// every printing of OP17-022, and those printings carry different treatments.
// The collector number is precisely what every variant of a card SHARES, so
// the join hands each card several candidate finishes and no way to choose.
//
// Writing one anyway puts the Manga printing's treatment on the base card, in
// the permanent catalogue — the same failure as pricing a Shadowless off
// Unlimited sales. So a card is written only when the candidates agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agreedFinish } from "../src/catalog/backfill.js";

test("one candidate is an answer", () => {
  assert.equal(agreedFinish(["Holofoil"]), "holo");
  assert.equal(agreedFinish(["Normal"]), "normal");
  assert.equal(agreedFinish(["Reverse Holofoil"]), "reverse");
});

test("the same finish spelled two ways still agrees", () => {
  // Normalisation before the agreement test, not after. Otherwise a card we
  // genuinely know about is discarded over a spelling.
  assert.equal(agreedFinish(["Holofoil", "Holo Rare"]), "holo");
  assert.equal(agreedFinish(["Foil", "Cold Foil"]), "foil");
});

test("candidates that disagree write nothing", () => {
  // The real case from the catalogue: a Base Set card exists as Holofoil AND
  // Reverse Holofoil, so there is no single right answer.
  assert.equal(agreedFinish(["Holofoil", "Reverse Holofoil"]), null);
  assert.equal(agreedFinish(["Holofoil", "Normal", "Reverse Holofoil"]), null);
  assert.equal(agreedFinish(["Normal", "Reverse Holofoil"]), null);
});

test("no candidates is not a finish", () => {
  assert.equal(agreedFinish([]), null);
  assert.equal(agreedFinish([null, null]), null);
});

test("an unrecognised sub_type is ignored, not invented", () => {
  // It must not become a new axis value, and it must not block a card whose
  // recognised candidates all agree.
  assert.equal(agreedFinish(["Sparkle Deluxe"]), null);
  assert.equal(agreedFinish(["Holofoil", "Sparkle Deluxe"]), "holo");
});

test("a lone unrecognised value never wins by default", () => {
  assert.equal(agreedFinish(["", null, "   "]), null);
});
