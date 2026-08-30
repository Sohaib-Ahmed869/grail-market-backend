// The order of this ladder is the product argument, so it is pinned.
//
// A PSA 10 sale is evidence about PSA 10. It is not evidence about a Beckett
// 9.5, and reaching for it first is how a Black Label came to be quoted at a
// PSA price. The same company's own neighbouring grades come first; crossing
// graders is the last resort and is always labelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceForGrade, sanityCheck, gradeIsInverted } from "../src/scans/ladder.js";

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

// ---- data-quality gates that need no outside source -----------------------

test("a higher grade worth less than a lower one is a defect, not a bargain", async () => {
  const { findInversions } = await import("../src/scans/ladder.js");
  // the real Dragon Frontiers Gold Star ladder, in USD
  const inv = findInversions({
    "7.5": pt(6350, 4), 8: pt(12400, 7), "8.5": pt(10500, 9), 9: pt(21300, 4),
  });
  assert.equal(inv.length, 1);
  assert.equal(inv[0].lower, 8);
  assert.equal(inv[0].higher, 8.5);
});

test("a clean ladder reports nothing", async () => {
  const { findInversions } = await import("../src/scans/ladder.js");
  assert.deepEqual(findInversions({ 8: pt(405), 9: pt(428), 10: pt(1150) }), []);
});

test("near-identical adjacent grades are noise, not a contradiction", async () => {
  const { findInversions } = await import("../src/scans/ladder.js");
  assert.deepEqual(findInversions({ 9: pt(1000), "9.5": pt(990) }), []);
});

test("asks far above sold is said out loud, not silently resolved", async () => {
  const { soldVsAsk } = await import("../src/scans/ladder.js");
  const d = soldVsAsk(10500, 17476);
  assert.equal(d.diverged, true);
  assert.match(d.note, /market has moved|not all this exact card/);
  // a normal ask premium is not flagged
  assert.equal(soldVsAsk(1000, 1300).diverged, false);
  assert.equal(soldVsAsk(null, 17476).diverged, false);
});

// ---- an ask may overrule a sale, but only a broken one --------------------

test("a broken sale loses to a clean ask at the same grader and grade", async () => {
  const { priceForSlab } = await import("../src/scans/pricing.js");
  // the real Gold Star ladder in USD: the 8.5 sits BELOW the 8 beneath it
  const byGrader = {
    BGS: { "7.5": pt(6350, 4), 8: pt(12400, 7), "8.5": pt(10500, 9), 9: pt(21300, 4) },
  };
  const r = await priceForSlab(byGrader, "BGS", 8.5, {
    median: 17476.5, count: 3, filteredToGrade: true,
  });
  assert.equal(r.basis, "ask-over-suspect-sale");
  assert.equal(r.price, 17476.5);
  assert.match(r.explain, /cannot be right/);
  assert.match(r.explain, /what sellers want, not what one sold for/);
});

test("a sound sale is never displaced by an ask", async () => {
  const { priceForSlab } = await import("../src/scans/pricing.js");
  // monotonic ladder — the recorded sale stands, however high the asks run
  const byGrader = { BGS: { 8: pt(400, 7), "8.5": pt(800, 9), 9: pt(1500, 4) } };
  const r = await priceForSlab(byGrader, "BGS", 8.5, {
    median: 9999, count: 8, filteredToGrade: true,
  });
  assert.equal(r.basis, "observed");
  assert.equal(r.price, 800);
});

test("an unfiltered or thin ask market cannot overrule anything", async () => {
  const { priceForSlab } = await import("../src/scans/pricing.js");
  const byGrader = { BGS: { 8: pt(12400, 7), "8.5": pt(10500, 9) } };
  // asks not narrowed to this grade — mixing grades is the error we started from
  const loose = await priceForSlab(byGrader, "BGS", 8.5, {
    median: 17476, count: 9, filteredToGrade: false,
  });
  assert.equal(loose.basis, "observed");
  // a single listing is an anecdote, not a market
  const thin = await priceForSlab(byGrader, "BGS", 8.5, {
    median: 17476, count: 1, filteredToGrade: true,
  });
  assert.equal(thin.basis, "observed");
});

// The Charizard Gold Star, cert #0011755115, exactly as the store held it.
// BGS 8.5 came back at $10,500 from nine sales while the BGS 8 beneath it sat
// at $12,715 from seven — a ladder that says half a grade of improvement cost
// the owner two thousand dollars. Three BGS 8.5 copies were listed at a
// A$24,153 median at the time and the owner had been valued at 25-30k.
//
// The inversion check below is what catches that. It was already written and
// had never once run, because the scan path fetched the asking market ONLY
// when there was no sale — so the one rule able to overrule a bad sale was
// gated on that sale not existing. This pins both halves: the ladder is
// detectably broken, and it is broken AT 8.5 rather than merely somewhere.
const GOLD_STAR_BGS_BYGRADER = { BGS: {
  "4": { price: 3850, sampleSize: 1 },
  "8": { price: 12715, sampleSize: 7 },
  "8.5": { price: 10500, sampleSize: 9 },
  "9": { price: 21338.5, sampleSize: 4 },
} };
const GOLD_STAR_BGS = {
  "4": { price: 3850, sampleSize: 1 },
  "4.5": { price: 6033.92, sampleSize: 2 },
  "5.5": { price: 4952.41, sampleSize: 2 },
  "6.5": { price: 6264.29, sampleSize: 2 },
  "7.5": { price: 6350, sampleSize: 4 },
  "8": { price: 12715, sampleSize: 7 },
  "8.5": { price: 10500, sampleSize: 9 },
  "9": { price: 21338.5, sampleSize: 4 },
  "9.5": { price: 24156, sampleSize: 1 },
};

test("the Gold Star's 8.5 is identified as the broken rung, not the 8", () => {
  assert.equal(gradeIsInverted(GOLD_STAR_BGS, 8.5), true, "8.5 sits under the 8");
  // The 8 is the higher-priced side of the same inversion. Quoting it is not
  // the error, so it must not be flagged — otherwise every inversion would
  // suppress two grades and the fallback would spread instead of correcting.
  assert.equal(gradeIsInverted(GOLD_STAR_BGS, 8), false);
  assert.equal(gradeIsInverted(GOLD_STAR_BGS, 9), false, "the top of the ladder is sound");
});

test("a clean ladder asks for no second opinion", () => {
  const sane = { "8": { price: 8000 }, "8.5": { price: 10500 }, "9": { price: 21338 } };
  for (const g of [8, 8.5, 9]) assert.equal(gradeIsInverted(sane, g), false);
});

test("an ask below the sale it claims to correct is refused", async () => {
  const { priceForSlab } = await import("../src/scans/pricing.js");
  // The inversion is real, so the rule is eligible to fire. The asking market
  // is $430 — a third of a percent of the grade below. That is not the 8.5
  // being corrected upward; it is a contaminated ask pool, and taking it turned
  // A$14,594 into A$379.44 on screen.
  const bad = await priceForSlab(GOLD_STAR_BGS_BYGRADER, "BGS", 8.5, {
    median: 430, count: 12, filteredToGrade: true,
  });
  assert.notEqual(bad.basis, "ask-over-suspect-sale", "a lower figure is not a correction");
  assert.equal(bad.price, 10500, "the flagged sale stands rather than being replaced by junk");

  // The genuine ask market for this card, which does point the right way.
  const good = await priceForSlab(GOLD_STAR_BGS_BYGRADER, "BGS", 8.5, {
    median: 17377.5, count: 3, filteredToGrade: true,
  });
  assert.equal(good.basis, "ask-over-suspect-sale");
  assert.equal(good.price, 17377.5);
});
