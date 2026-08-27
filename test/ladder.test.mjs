// The order of this ladder is the product argument, so it is pinned.
//
// A PSA 10 sale is evidence about PSA 10. It is not evidence about a Beckett
// 9.5, and reaching for it first is how a Black Label came to be quoted at a
// PSA price. The same company's own neighbouring grades come first; crossing
// graders is the last resort and is always labelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceForGrade, sanityCheck } from "../src/scans/ladder.js";

const pt = (price, count = 20, confidence = "high") => ({ price, count, confidence });

test("a real sale at the exact key wins, and is marked observed", async () => {
  const r = await priceForGrade(
    { BGS: { "9.5": pt(801.5, 28, "medium") }, PSA: { 10: pt(1150, 986) } },
    "BGS",
    9.5,
  );
  assert.equal(r.basis, "observed");
  assert.equal(r.price, 801.5);
  assert.equal(r.sampleSize, 28);
});

test("the same grader's neighbours beat a different grader entirely", async () => {
  // BGS 9 and BGS 10 bracket a BGS 9.5. PSA 10 is present and much bigger, and
  // must not be touched — different company, different scale, different buyers.
  const r = await priceForGrade(
    {
      BGS: { 9: pt(407), 10: pt(1363.92, 23) },
      PSA: { 10: pt(1150, 986) },
    },
    "BGS",
    9.5,
  );
  assert.equal(r.basis, "same-grader-interpolated");
  assert.ok(r.price > 407 && r.price < 1363.92, `got ${r.price}`);
  assert.match(r.explain, /same scale and the same buyers/);
});

test("interpolation is multiplicative, because prices are", async () => {
  // halfway between 100 and 400 up a grade ladder is 200, not 250
  const r = await priceForGrade({ BGS: { 9: pt(100), 10: pt(400) } }, "BGS", 9.5);
  assert.ok(Math.abs(r.price - 200) < 1, `got ${r.price}`);
});

test("one neighbour still beats crossing graders, and says which way it leans", async () => {
  const below = await priceForGrade({ BGS: { 9: pt(407) }, PSA: { 10: pt(1150) } }, "BGS", 9.5);
  assert.equal(below.basis, "same-grader-nearest");
  assert.match(below.explain, /floor/);

  const above = await priceForGrade({ BGS: { 10: pt(1363) }, PSA: { 10: pt(1150) } }, "BGS", 9);
  assert.equal(above.basis, "same-grader-nearest");
  assert.match(above.explain, /ceiling/);
});

test("nothing for this grader anywhere is null, not a PSA number in disguise", async () => {
  // no BGS data at all, and too little history to model from — the honest
  // answer is that we do not know
  const r = await priceForGrade({ PSA: { 10: pt(1150, 986) } }, "BGS", 9.5);
  if (r !== null) {
    // if a model DID fire it must announce itself as modelled, never observed
    assert.equal(r.basis, "modelled-cross-grader");
    assert.equal(r.confidence, "low");
    assert.match(r.explain, /modelled, not observed/);
  }
});

test("a derived figure outside the card's own envelope is flagged, not shipped", () => {
  const byGrader = { PSA: { 8: pt(405), 9: pt(428), 10: pt(1150) } };
  const wild = {
    price: 91000, low: null, high: null, sampleSize: 5, confidence: "low",
    basis: "modelled-cross-grader", method: "test", explain: "test",
  };
  const checked = sanityCheck(wild, byGrader, "BGS", 9.5);
  assert.equal(checked.suspect, true);
  assert.match(checked.suspectReason, /envelope/);
});

test("an observed sale is never second-guessed by the envelope", () => {
  // a real Black Label sale at 11x PSA 10 is a fact about the market, not a
  // modelling error, and the sanity band must not touch it
  const byGrader = { PSA: { 9: pt(428), 10: pt(1150) } };
  const real = {
    price: 13120, low: null, high: null, sampleSize: 4, confidence: "high",
    basis: "observed", method: "sold-comps", explain: "test",
  };
  assert.equal(sanityCheck(real, byGrader, "BGS", 10).suspect, undefined);
});
