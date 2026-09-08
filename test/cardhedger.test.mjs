// The bought catalogue, where it touches the one rule that must not bend.
//
// Invariant 1: a grade is a property of (card + grading company), never of the
// card alone. Every price this system stores is keyed on the company as well
// as the rung, and there is no grade-only lookup anywhere.
//
// A new provider is where that gets broken, because their rows are not shaped
// like ours. Card Hedge sends a grade sometimes as two fields and sometimes as
// one string, and a reader that shrugs and defaults to PSA is how a Beckett
// number ends up under a PSA badge — the exact failure the invariant exists
// to prevent, and one this project has already had once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitGrade } from "../src/scans/cardhedger.js";

test("a structured row keeps its own company", () => {
  assert.deepEqual(splitGrade({ grader: "BGS", grade: 9.5 }), { grader: "BGS", grade: "9.5" });
  assert.deepEqual(splitGrade({ grading_company: "cgc", grade: "10" }), { grader: "CGC", grade: "10" });
  assert.deepEqual(splitGrade({ company: "SGC", grade_value: "8" }), { grader: "SGC", grade: "8" });
});

test("a single string is split rather than guessed at", () => {
  assert.deepEqual(splitGrade({ grade: "PSA 10" }), { grader: "PSA", grade: "10" });
  assert.deepEqual(splitGrade({ grade: "BGS 9.5" }), { grader: "BGS", grade: "9.5" });
  assert.deepEqual(splitGrade({ grade: "CGC 10 Pristine" }), { grader: "CGC", grade: "10" });
  assert.deepEqual(splitGrade({ label: "SGC 9" }), { grader: "SGC", grade: "9" });
});

test("the same rung written two ways is one rung", () => {
  // "10.0" and "10" have to collide, or the store grows two rows for one
  // grade and a lookup finds whichever was written last.
  assert.equal(splitGrade({ grader: "PSA", grade: "10.0" }).grade, "10");
  assert.equal(splitGrade({ grader: "PSA", grade: 10 }).grade, "10");
  assert.equal(splitGrade({ grader: "BGS", grade: "9.50" }).grade, "9.5");
});

test("a row with no company is refused, never defaulted", () => {
  // The whole point. Every one of these would price a card, and none of them
  // says whose scale it is on.
  for (const row of [
    { grade: "10" },
    { grade: 9.5 },
    { grade: "Gem Mint" },
    { grade: "" },
    {},
    { grader: "", grade: "10" },
  ]) {
    const r = splitGrade(row);
    assert.equal(r.grader, null, `must not invent a company for ${JSON.stringify(row)}`);
  }
});

test("raw is a state, and it is allowed to say so", () => {
  // Ungraded is not a missing company — it is its own answer, and the raw
  // price has its own column rather than a synthetic RAW grader in the
  // graded table.
  assert.deepEqual(splitGrade({ grade: "Raw" }), { grader: "RAW", grade: "RAW" });
  assert.deepEqual(splitGrade({ grade: "ungraded" }), { grader: "RAW", grade: "RAW" });
});

test("a BCCG number does not become a Beckett one", () => {
  // BCCG is Beckett's discount line and a BCCG 10 is worth a fraction of a
  // BGS 10. It has to survive as its own company.
  assert.equal(splitGrade({ grade: "BCCG 10" }).grader, "BCCG");
  assert.notEqual(splitGrade({ grade: "BCCG 10" }).grader, "BGS");
});
