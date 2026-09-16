// Which listings are slabs. A raw card's asks are computed over loose copies
// only, so a grading company this list does not know prices a slab as a loose
// card: a GMG 10 Josue De Paula asking US$24.50 against a raw pool of
// A$1.40-A$5.61. It survived only because the seller also typed "Graded".
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeFromTitle, graderTier, isGradedListing } from "../src/scans/graders.js";

test("the newer graders are slabs", () => {
  for (const title of [
    "2026 Bowman Josue De Paula Rookie GMG Graded 10 Gem Mint RC #BP83 Dodgers",
    "Charizard ISA 9 Base Set",
    "Pikachu HGA 10 Gem Mint",
    "Luffy PGI 10 OP01-003",
    "Mickey Mantle WCG 8",
    "Jordan CGA 9.5 Fleer",
    "Josue De Paula Arena Club 10 RC",
    "Victor Wembanyama Rare Edition 10",
    "Kobe CSG 9.5 Topps Chrome",
  ]) {
    assert.equal(isGradedListing(title), true, title);
  }
});

test("a company with no number is still a slab", () => {
  // "PSA" in a title means a holder even when the grade is written elsewhere.
  assert.equal(isGradedListing("Charizard PSA Gem Mint Base Set"), true);
  assert.equal(isGradedListing("Charizard Graded Gem Mint"), true);
});

test("Raw Card Review is not a slab, whatever the title says", () => {
  // Invariant 3: BRCR carries a company name and a number and prices as raw.
  assert.equal(isGradedListing("Charizard BRCR 9 Raw Card Review"), false);
  assert.equal(isGradedListing("Pikachu RCR 8 graded"), false);
  assert.deepEqual(gradeFromTitle("Charizard BRCR 9"), { grader: null, grade: null });
});

test("a card word that names a grader is not a slab without a number", () => {
  // Both were in the old bare list, so these raw cards were dropped from their
  // own raw pool: "TAG TEAM" is a Pokemon mechanic, Ace a One Piece character.
  assert.equal(isGradedListing("Pikachu & Zekrom GX TAG TEAM 33/181"), false);
  assert.equal(isGradedListing("Portgas D. Ace OP02-013 Manga Art"), false);
  assert.equal(isGradedListing("Charizard GEM MNT condition raw"), false);
  // ...and still a slab when the number is there
  assert.equal(isGradedListing("Pikachu TAG 9.5"), true);
  assert.equal(isGradedListing("Portgas D. Ace ACE 10"), true);
});

test("the grade and company come off the title", () => {
  assert.deepEqual(gradeFromTitle("Josue De Paula GMG 10 RC"), { grader: "GMG", grade: 10 });
  assert.deepEqual(gradeFromTitle("Charizard BGS 8.5"), { grader: "BGS", grade: 8.5 });
  // Beckett is BGS; BCCG is not (invariant 3)
  assert.deepEqual(gradeFromTitle("Charizard Beckett 9"), { grader: "BGS", grade: 9 });
  assert.deepEqual(gradeFromTitle("Charizard BCCG 10"), { grader: "BCCG", grade: 10 });
  assert.equal(gradeFromTitle("Charizard 4/102 holo").grader, null);
});

test("a number off the 1-10 scale is not a grade", () => {
  // A print run or a card number that happens to follow a company name.
  assert.equal(gradeFromTitle("Charizard PSA 199").grade, null);
  assert.equal(gradeFromTitle("Charizard PSA 199").grader, "PSA");
});

test("every grader this file knows has a tier", () => {
  for (const g of ["GMG", "ISA", "PGI", "WCG", "CGA", "ARENA CLUB", "RARE EDITION"]) {
    assert.ok(graderTier(g), g);
  }
  // and the tiers still separate the leagues
  assert.equal(graderTier("PSA"), "premium");
  assert.equal(graderTier("BCCG"), "discount");
  assert.equal(graderTier("nonesuch"), null);
});
