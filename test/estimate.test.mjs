// The estimator only runs where no sale exists, which is exactly where a wrong
// number is hardest for a reader to catch. These pin the three decisions that
// make it safe: asks are biased high, unsold listings argue against themselves,
// and disagreeing inputs produce no number at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateFromListings,
  isRefusal,
  ageWeight,
  sellerWeight,
  matchWeight,
} from "../src/scans/estimate.js";

const listing = (price, o = {}) => ({
  title: o.title ?? "Charizard Gold Star Dragon Frontiers BGS 8.5",
  price,
  currency: "USD",
  condition: "Graded",
  imageUrl: null,
  url: "https://ebay.com/x",
  seller: o.seller ?? "shop",
  sellerFeedbackPct: o.pct ?? 100,
  sellerFeedbackCount: o.count ?? 2000,
  bestOffer: o.bestOffer ?? false,
  grader: "BGS",
  grade: 8.5,
  labelVariant: null,
  printing: null,
  ageDays: o.ageDays ?? 5,
  printingMatch: "unknown",
});

// ---- the weights -----------------------------------------------------------

test("an unsold listing loses weight as it ages, but never reaches zero", () => {
  assert.equal(ageWeight(3), 1, "fresh asks are live claims");
  assert.ok(ageWeight(90) < ageWeight(20), "older is weaker");
  assert.ok(ageWeight(400) >= 0.15, "still evidence — of being too expensive");
  assert.ok(ageWeight(null) > 0.15 && ageWeight(null) < 1, "unknown age sits in the middle");
});

test("an established seller outweighs a brand-new account", () => {
  assert.ok(sellerWeight(100, 6132) > sellerWeight(100, 2));
  assert.ok(sellerWeight(89, 5000) < 0.5, "poor feedback is discounted whatever the volume");
  // a big shop should not be worth ten small ones
  assert.ok(sellerWeight(100, 50000) - sellerWeight(100, 500) < 0.1);
});

test("a listing carrying the label's words outweighs one sharing only a number", () => {
  const tokens = ["MAGAZINEEXCLUSIVE"];
  assert.equal(matchWeight(listing(1, { title: "PSA MAGAZINE EXCLUSIVE Luffy" }), { labelTokens: tokens }), 1);
  assert.ok(matchWeight(listing(1, { title: "Luffy OP05-060 Leader" }), { labelTokens: tokens }) < 1);
  // nothing to match on must not punish everything
  assert.equal(matchWeight(listing(1), { labelTokens: [] }), 1);
});

// ---- the estimate ----------------------------------------------------------

test("the estimate sits below the median, because asks sit above sales", () => {
  const asks = [100, 110, 120, 130, 140, 150].map((p) => listing(p));
  const r = estimateFromListings(asks, { grader: "BGS", grade: 8.5 });
  assert.ok(!isRefusal(r));
  assert.ok(r.estimate < 125, `got ${r.estimate} — should be under the median of 125`);
  assert.ok(r.estimate > 60, "and not absurdly under it");
});

test("a stale expensive listing does not drag the estimate up", () => {
  const fresh = [100, 105, 110, 115].map((p) => listing(p, { ageDays: 3 }));
  const stale = listing(900, { ageDays: 400 });
  const withStale = estimateFromListings([...fresh, stale], { grader: "BGS", grade: 8.5 });
  const without = estimateFromListings(fresh, { grader: "BGS", grade: 8.5 });
  assert.ok(!isRefusal(withStale) && !isRefusal(without));
  assert.ok(
    withStale.estimate < without.estimate * 1.35,
    `a 400-day-old ask moved the estimate from ${without.estimate} to ${withStale.estimate}`,
  );
});

test("the extreme listing is surfaced, never silently dropped", () => {
  const asks = [100, 105, 110, 115, 120].map((p) => listing(p));
  const r = estimateFromListings([...asks, listing(94000, { ageDays: 2 })], {
    grader: "BGS", grade: 8.5,
  });
  if (!isRefusal(r)) {
    assert.ok(r.notable.some((l) => l.price === 94000), "the $94,000 ask must be reported");
  }
});

// ---- refusing --------------------------------------------------------------

test("two listings is an anecdote, and produces no number", () => {
  const r = estimateFromListings([listing(100), listing(120)], { grader: "PSA", grade: 10 });
  assert.ok(isRefusal(r));
  assert.equal(r.reason, "too-few");
  assert.match(r.explain, /anecdote rather than a market/);
});

test("a 100x spread means several products, so it refuses", () => {
  // the Eustass Kid case: sleeves and a figurine alongside a prize card
  const r = estimateFromListings(
    [4, 5, 8, 9, 16, 27, 94000].map((p) => listing(p)),
    { grader: "PSA", grade: 10 },
  );
  assert.ok(isRefusal(r), "must not average a $4 sleeve with a $94,000 prize card");
  assert.equal(r.reason, "too-wide");
  assert.ok(r.low != null && r.high != null, "the range is still reported");
});

test("a confident answer needs both volume and recency", () => {
  const thin = estimateFromListings(
    [100, 110, 120, 130].map((p) => listing(p, { ageDays: 300 })),
    {},
  );
  assert.ok(!isRefusal(thin));
  assert.equal(thin.confidence, 1, "old and thin is a 1, whatever the number says");

  const good = estimateFromListings(
    Array.from({ length: 10 }, (_, i) => listing(100 + i, { ageDays: 5 })),
    { askToSold: { factor: 0.82, measured: true } },
  );
  assert.ok(!isRefusal(good));
  assert.ok(good.confidence >= 4, `fresh, plentiful and measured should be 4+, got ${good.confidence}`);
});

test("an assumed ask-to-sold ratio is admitted to, not hidden", () => {
  const r = estimateFromListings([100, 110, 120, 130, 140].map((p) => listing(p)), {});
  assert.ok(!isRefusal(r));
  assert.equal(r.askToSold.measured, false);
  assert.match(r.method, /assumed/);
});
