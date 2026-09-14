// The canonical card identity — GM001-13.
//
// A catalog_id names a CATALOGUE ENTRY, not a product. "base1-4" covers a 1st
// Edition, a Shadowless and an Unlimited Charizard, English and Japanese, holo
// and reverse. Their prices do not overlap, and keying anything on catalog_id
// alone is how a Shadowless gets priced off Unlimited sales.
//
// The rule these tests exist to hold: an UNKNOWN axis is not a wildcard. A
// seller who did not say "Unlimited" has not said "1st Edition".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toSku, skuKey, sameSku, compareSku, describeSku,
  asLanguage, asEdition, asFinish,
} from "../src/catalog/sku.js";

const base = (over = {}) => toSku({ catalogId: "base1-4", game: "pokemon", ...over });

test("the axes normalise from the spellings people actually use", () => {
  assert.equal(asEdition("1st Edition"), "1st");
  assert.equal(asEdition("First Edition"), "1st");
  assert.equal(asEdition("UNLIMITED"), "unlimited");
  assert.equal(asFinish("Reverse Holo"), "reverse");
  assert.equal(asFinish("Holofoil"), "holo");
  assert.equal(asFinish("non-holo"), "normal");
  assert.equal(asLanguage("Japanese"), "ja");
  assert.equal(asLanguage("JPN"), "ja");
});

test("an unrecognised value is null, never stored as a new axis value", () => {
  assert.equal(asEdition("second edition"), null);
  assert.equal(asFinish("sparkly"), null);
  assert.equal(asLanguage("klingon"), null);
  assert.equal(toSku({ catalogId: "x", finish: "sparkly" }).finish, null);
});

test("two editions of one catalogue entry are different SKUs", () => {
  const first = base({ edition: "1st" });
  const unl = base({ edition: "unlimited" });
  assert.notEqual(skuKey(first), skuKey(unl));
  assert.equal(sameSku(first, unl), false);
  assert.equal(compareSku(first, unl), "conflict");
});

test("language separates SKUs too", () => {
  assert.equal(compareSku(base({ language: "ja" }), base({ language: "en" })), "conflict");
});

test("finish separates SKUs too", () => {
  assert.equal(compareSku(base({ finish: "reverse" }), base({ finish: "normal" })), "conflict");
});

test("an unknown axis does NOT match a known one, strictly", () => {
  // The strict reading, used wherever a price key is built. Treating null as a
  // wildcard is how an Unlimited card is priced off 1st Edition sales because
  // the seller simply did not say.
  assert.equal(sameSku(base({ edition: "1st" }), base()), false);
});

test("the loose reading reports undecided rather than pretending", () => {
  // For a caller that knows it is guessing and wants to lower its confidence.
  assert.equal(compareSku(base({ edition: "1st" }), base()), "unknown");
  assert.equal(compareSku(base(), base()), "unknown");
  assert.equal(
    compareSku(base({ edition: "1st", language: "en", finish: "holo" }),
               base({ edition: "1st", language: "en", finish: "holo" })),
    "match",
  );
});

test("a different card is a conflict whatever the axes say", () => {
  const a = toSku({ catalogId: "base1-4", edition: "1st" });
  const b = toSku({ catalogId: "base1-2", edition: "1st" });
  assert.equal(compareSku(a, b), "conflict");
});

test("the key has a fixed shape so two SKUs cannot collide by omission", () => {
  // "we do not know" renders as "-", which must be distinguishable from a
  // real value and must not shorten the key.
  assert.equal(skuKey(base()), "base1-4|-|-|-");
  assert.equal(skuKey(base({ language: "ja" })), "base1-4|ja|-|-");
  assert.equal(skuKey(base()).split("|").length, skuKey(base({ finish: "holo" })).split("|").length);
});

test("describing a SKU says only what is worth saying", () => {
  // English is the unmarked case in this market and adds nothing; "Non-Holo"
  // alone is noise.
  assert.equal(describeSku(base()), null);
  assert.equal(describeSku(base({ language: "en" })), null);
  assert.equal(describeSku(base({ finish: "normal" })), null);
  assert.equal(describeSku(base({ edition: "1st" })), "1st Edition");
  assert.equal(
    describeSku(base({ language: "ja", edition: "unlimited", finish: "reverse" })),
    "Japanese · Unlimited · Reverse Holo",
  );
});

test("a grade is not part of the SKU", () => {
  // Invariant 1: a grade is a property of (card + grading company). It sits ON
  // a SKU, never inside it — otherwise a PSA 10 Shadowless and a PSA 10
  // Unlimited become one thing again.
  const s = toSku({ catalogId: "base1-4", edition: "shadowless", grade: "10", grader: "PSA" });
  assert.equal("grade" in s, false);
  assert.equal("grader" in s, false);
  assert.equal(skuKey(s), "base1-4|-|shadowless|-");
});
