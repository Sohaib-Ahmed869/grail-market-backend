// A sold price is evidence, and this is where a title becomes one.
//
// Invariant 4: a grade token in text does not mean the card is graded. Until
// this adapter there was nowhere that rule was enforced in code — the asks
// path reads a grade off a title only to MATCH listings, which is a cheaper
// decision than writing an append-only ledger row keyed on (grader, grade).
//
// The Card API's eBay half is raw seller prose and nothing else: no grader
// field, no set, no number, 304,421 rows in a three-day window. Every one of
// the aspirational titles below is a real way people sell a RAW card by
// naming the slab they hope for, and each trades at a fraction of that slab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { saleGrade, normaliseGrade, matchesTarget, setEditionMismatch, compQuery } from "../src/scans/thecardapi.js";

const raw = (title, extra = {}) => saleGrade({ title, ...extra });

test("a structured row is taken at its word", () => {
  const g = saleGrade({ title: "Dark Slowbro (12) - Team Rocket", grader: "PSA", grade: 9 });
  assert.equal(g.grader, "PSA");
  assert.equal(g.grade, "9");
  assert.equal(g.reason, "structured");
});

test("half a key is never completed by guessing", () => {
  // Invariant 1. A rung with no company, or a company with no rung, is not a
  // price key — and defaulting either to PSA is the failure the invariant
  // exists to prevent.
  assert.equal(saleGrade({ title: "Charizard", grade: 10 }).grader, null);
  assert.equal(saleGrade({ title: "Charizard", grader: "PSA" }).grade, null);
  assert.equal(saleGrade({ title: "Charizard", grade: 10 }).reason, "half-a-key");
});

test("aspirational titles are raw, not graded", () => {
  for (const t of [
    "2016 Charizard BREAKpoint 17/122 PSA 10 CANDIDATE",
    "Pikachu VMAX - would grade PSA 9 easily",
    "Base Set Blastoise UNGRADED (not PSA 10)",
    "Mewtwo GX - raw, PSA 10 potential",
    "Umbreon VMAX ready to grade PSA 10",
    "Lugia Neo Genesis - gem mint, comes back PSA 10",
  ]) {
    const g = raw(t);
    assert.equal(g.grader, null, `graded a raw card: ${t}`);
    assert.equal(g.grade, null, `graded a raw card: ${t}`);
  }
});

test("a question is not a slab", () => {
  assert.equal(raw("Charizard Base Set shadowless - PSA 10?").grader, null);
});

test("a number next to a company name is still a number", () => {
  // "#PSA 10" and "PSA 10/102" are a collector number wearing a grade token.
  assert.equal(raw("Charizard Base Set #PSA 10").grader, null);
  assert.equal(raw("Charizard Base Set PSA 10/102 holo").grader, null);
});

test("a real slab survives all of it", () => {
  const g = raw("2016 Pokemon XY Evolutions Charizard 11/108 PSA 10 GEM MINT");
  assert.equal(g.grader, "PSA");
  assert.equal(g.grade, "10");
  assert.equal(g.reason, "title");
});

test("Beckett is Beckett and BCCG is not", () => {
  // Invariant 3: BCCG is a discount tier, not Beckett's main line. It must
  // never normalise into BGS.
  assert.equal(raw("Charizard BECKETT 9.5").grader, "BGS");
  assert.equal(raw("Charizard BGS 9.5").grade, "9.5");
  assert.equal(raw("Charizard BCCG 10").grader, "BCCG");
  assert.notEqual(raw("Charizard BCCG 10").grader, "BGS");
});

test("Raw Card Review is priced as raw", () => {
  // Invariant 3 again. BRCR carries a company name and a number and is not a
  // slab at all.
  assert.equal(raw("Charizard BRCR 9").grader, null);
  assert.equal(raw("Charizard BRCR 9").reason, "review-not-slab");
});

test("a lot is not a comparable at any grade", () => {
  assert.equal(raw("Lot of 12 Pokemon cards PSA 10 included").grader, null);
  assert.equal(raw("Pokemon break slot PSA 10 charizard").grader, null);
});

test("a qualifier stays in the key", () => {
  // PSA 8 (OC) trades below a clean PSA 8. Dropping the qualifier merges two
  // different prices into one rung.
  const g = raw("1999 Charizard Base Set PSA 8 OC");
  assert.equal(g.grader, "PSA");
  assert.equal(g.grade, "8");
  assert.equal(g.qualifier, "OC");
});

test("one rung is one rung however it is written", () => {
  assert.equal(normaliseGrade("10.0"), "10");
  assert.equal(normaliseGrade(10), "10");
  assert.equal(normaliseGrade("9.50"), "9.5");
  assert.equal(normaliseGrade("0"), null);
  assert.equal(normaliseGrade("2500"), null); // a print run, not a grade
  assert.equal(normaliseGrade(""), null);
});

// ------------------------------------------------------------- matching

const sale = (title, extra = {}) => ({
  id: "x", platform: "eBay", title, listingType: null, soldAt: "2026-09-11",
  price: 10, askedPrice: null, currency: "USD", url: null, imageUrl: null,
  cardSet: null, cardNumber: null, condition: null, features: [], ...extra,
});

const MEGANIUM = {
  catalogId: "me01-010", name: "Meganium", setName: "Mega Evolution", number: "010",
};

test("the US$195 bug does not come back through the sold feed", () => {
  // Twelve "Mega Meganium ex" listings once priced a Meganium at US$195
  // against a true US$0.24. An ask that says that is wrong; a SOLD row that
  // says it is wrong AND written into an append-only ledger.
  assert.equal(matchesTarget(sale("Mega Meganium ex 034 ME Mega Evolution Promo"), MEGANIUM), null);
});

test("a sale of the actual card matches", () => {
  assert.equal(matchesTarget(sale("Pokemon Meganium 010 Mega Evolution holo NM"), MEGANIUM), "title");
});

test("structured fields that disagree are a no, not a fallthrough", () => {
  // The row already told us it is card 034. Falling through to the title
  // would let prose overrule the marketplace's own record.
  const row = sale("Meganium - 034 - ME: Mega Evolution Promo", {
    platform: "TCGplayer", cardSet: "ME: Mega Evolution Promo", cardNumber: "034",
  });
  assert.equal(matchesTarget(row, MEGANIUM), null);
});

test("structured fields that agree beat the title", () => {
  const row = sale("Meganium - 010 - ME: Mega Evolution - Holofoil", {
    platform: "TCGplayer", cardSet: "ME: Mega Evolution", cardNumber: "010",
  });
  assert.equal(matchesTarget(row, MEGANIUM), "fields");
});

test("a wrong number in a title is refused", () => {
  assert.equal(matchesTarget(sale("Pokemon Meganium 011/100 Mega Evolution"), MEGANIUM), null);
});

// ------------------------------------------------- sequel sets

test("Base Set 2 is not Base Set", () => {
  // Different sets eight months apart: the original's Charizard is 4/102 and
  // the sequel's is 4/130, and the gap between them is five figures. Both
  // reduce to "BASE" once SET is dropped as a stopword, so setInTitle cannot
  // separate them and this has to.
  assert.equal(setEditionMismatch("Pokemon TCG Charizard 4/130 Base Set 2 Holo Rare", "Base Set"), true);
  assert.equal(setEditionMismatch("[PSA 8] Pokemon Charizard #4/130 Holo - Base Set 2 2000", "Base Set"), true);
});

test("Base Set is Base Set", () => {
  for (const t of [
    "1999 Pokemon Base Set #4/102 Charizard Holo",
    "Charizard 4/102 1st Edition Base Set (Shadowless) Holo [Thin Stamp]",
    "1999 Wizards Pokemon TCG Charizard Base Set Holo 4/102",
    "Pokemon TCG Charizard 4/102 Base Set Holo Rare WOTC VTG",
  ]) {
    assert.equal(setEditionMismatch(t, "Base Set"), false, `rejected a real Base Set card: ${t}`);
  }
});

test("a collector number is never read as an edition ordinal", () => {
  // The whole reason this matches on the raw text rather than on word
  // tokens: "#4/102" tokenises to a bare "4" that looks exactly like the "2"
  // in "Base Set 2", and reading it as one would reject every correctly
  // numbered listing there is.
  assert.equal(setEditionMismatch("Pokemon Base Set #4/102 Charizard", "Base Set"), false);
  assert.equal(setEditionMismatch("Pokemon Base Set 4/102 Charizard", "Base Set"), false);
});

test("looking for the sequel, the original is the mismatch", () => {
  assert.equal(setEditionMismatch("1999 Pokemon Base Set Charizard 4/102", "Base Set 2"), true);
  assert.equal(setEditionMismatch("Pokemon Charizard 4/130 Base Set 2", "Base Set 2"), false);
});

test("a sequel row cannot reach the ledger through the number alone", () => {
  // End to end: 4/130 states the card number 4, which used to be enough on
  // its own. Now the set has to agree as well.
  const row = sale("Pokemon TCG Charizard 4/130 Base Set 2 Holo Rare");
  assert.equal(matchesTarget(row, { catalogId: "base1-4", name: "Charizard", setName: "Base Set", number: "4" }), null);
});
