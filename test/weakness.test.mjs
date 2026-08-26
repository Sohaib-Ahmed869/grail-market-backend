// The backlog is only useful if it catches the right cases. Too eager and it
// logs every scan and nobody reads it; too shy and the answers we get wrong
// stay invisible. These pin the boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWeakness } from "../src/scans/scans.service.js";

const ident = { name: "Umbreon VMAX", cardId: "swsh7-215", game: "pokemon" };

test("a confident sale is not backlog — the log is for work, not volume", () => {
  const scan = {
    status: "analyzed",
    identification: ident,
    valuation: {
      slabGrader: "PSA", slabGrade: 10,
      pricesByGrader: { PSA: { 10: { price: 4250, count: 412, confidence: "high" } } },
    },
  };
  assert.equal(classifyWeakness(scan, 4250), null);
});

test("not knowing the card is the worst outcome and outranks everything", () => {
  const scan = { status: "analyzed", identification: null, valuation: null };
  assert.equal(classifyWeakness(scan, null).reason, "no-identification");
});

test("a declined photo is not a weak answer — we never claimed one", () => {
  assert.equal(classifyWeakness({ status: "rejected", identification: null }, null), null);
});

test("a named card with no number at all is logged", () => {
  const scan = { status: "analyzed", identification: ident, valuation: null };
  assert.equal(classifyWeakness(scan, null).reason, "no-price");
});

test("a slab priced from something other than a sale at ITS grade is logged", () => {
  // the substitution the grader-keyed model exists to prevent: a BGS card
  // showing a number that came from an ask or a raw price
  const scan = {
    status: "analyzed",
    identification: ident,
    valuation: {
      slabGrader: "BGS", slabGrade: 9.5,
      liveAsk: { median: 2950 },
      pricesByGrader: { PSA: { 10: { price: 4250, count: 412, confidence: "high" } } },
    },
  };
  assert.equal(classifyWeakness(scan, null).reason, "no-sales-at-grade");
});

test("a median over three sales is arithmetic, not evidence", () => {
  const scan = {
    status: "analyzed",
    identification: ident,
    valuation: {
      slabGrader: "PSA", slabGrade: 9,
      pricesByGrader: { PSA: { 9: { price: 900, count: 3, confidence: "medium" } } },
    },
  };
  const w = classifyWeakness(scan, 900);
  assert.equal(w.reason, "tiny-sample");
  assert.equal(w.sampleSize, 3);
});

test("the source's own low-confidence rating is carried through", () => {
  const scan = {
    status: "analyzed",
    identification: ident,
    valuation: {
      slabGrader: "PSA", slabGrade: 9,
      pricesByGrader: { PSA: { 9: { price: 900, count: 40, confidence: "low" } } },
    },
  };
  assert.equal(classifyWeakness(scan, 900).reason, "low-confidence");
});

test("a figure we inferred rather than measured is always logged", () => {
  const scan = {
    status: "analyzed",
    identification: ident,
    valuation: { tcgplayer: { market: 84 }, webEstimate: { value: 84, sampleSize: 2 } },
  };
  assert.equal(classifyWeakness(scan, null).reason, "estimated-only");
});
