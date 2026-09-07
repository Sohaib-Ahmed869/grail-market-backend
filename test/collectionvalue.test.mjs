// A slab with no grade on it is not a raw card.
//
// Both rows here are real, out of the collection table on 2026-09-04. The
// owner picked a grading company on the add screen and left the grade box
// empty, which the form allows, so `grade` is null and `grader` is not:
//
//   Pikachu δ   ex12-93   CGC   grade null
//   Palkia      cel25-4   BGS   grade null
//
// The old branch was `e.grader && e.grade ? ladder : rawUsd`, so a null grade
// fell through to the RAW price and the screen printed 23 cents under a badge
// reading BECKETT. That is invariant 1 inverted — a grade-only lookup is
// banned, and this was worse, a no-grade lookup answered with the ungraded
// price — and it is the "slab quoted at its raw price" failure arriving
// through the collection instead of the asks.
//
// A missing answer is cheap. 23 cents for a graded Celebrations Palkia is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { valueOfEntry } from "../src/listings/collectionvalue.js";

// What gradedPricesFor returns for cel25-4: a raw price, no ladders at all.
const PALKIA = { rawUsd: 0.23, byGrader: null, byGrade: null };
// ...and for ex12-93: nothing either way. The only signal for this card is the
// live ask pool, which the collection deliberately does not buy per entry.
const PIKACHU = { rawUsd: null, byGrader: null, byGrade: null };
const CHARIZARD = {
  rawUsd: 310,
  byGrader: { BGS: { "8.5": { price: 2400 } }, PSA: { 9: { price: 3100 } } },
};

test("a grader with no grade is unpriced, never the raw price", () => {
  assert.deepEqual(valueOfEntry({ grader: "BGS", grade: null }, PALKIA), {
    value: null, unpriced: "grade",
  });
  assert.deepEqual(valueOfEntry({ grader: "CGC", grade: null }, PIKACHU), {
    value: null, unpriced: "grade",
  });
  // The raw price EXISTS for Palkia and is still refused, which is the whole
  // point: having a number is not the same as having this card's number.
  assert.equal(PALKIA.rawUsd, 0.23);
});

test("an empty-string grade counts as no grade, not as grade zero", () => {
  // The form sends "" rather than null when the box is cleared.
  assert.deepEqual(valueOfEntry({ grader: "PSA", grade: "" }, CHARIZARD), {
    value: null, unpriced: "grade",
  });
});

test("a graded card is priced at its own company and rung", () => {
  assert.deepEqual(valueOfEntry({ grader: "BGS", grade: "8.5" }, CHARIZARD), {
    value: 2400, unpriced: null,
  });
  // Never another company's figure, even though PSA 9 is sitting right there.
  assert.deepEqual(valueOfEntry({ grader: "SGC", grade: "8.5" }, CHARIZARD), {
    value: null, unpriced: "sales",
  });
  // Never a neighbouring rung of its own company's ladder.
  assert.deepEqual(valueOfEntry({ grader: "BGS", grade: "9" }, CHARIZARD), {
    value: null, unpriced: "sales",
  });
});

test("an ungraded card is priced raw, which is what it is", () => {
  assert.deepEqual(valueOfEntry({ grader: null, grade: null }, PALKIA), {
    value: 0.23, unpriced: null,
  });
  assert.deepEqual(valueOfEntry({ grader: "", grade: null }, PALKIA), {
    value: 0.23, unpriced: null,
  });
  assert.deepEqual(valueOfEntry({ grader: null, grade: null }, PIKACHU), {
    value: null, unpriced: "price",
  });
});

test("a lookup that threw is unpriced, not zero", () => {
  assert.deepEqual(valueOfEntry({ grader: "BGS", grade: "8.5" }, null), {
    value: null, unpriced: "price",
  });
});

test("the reason is specific enough to act on", () => {
  // "grade" means the owner can fix it themselves by editing the entry, and
  // the screen says so. "sales" and "price" mean we have nothing and no
  // amount of editing helps. Collapsing them into one blank is what made the
  // collection read as broken rather than incomplete.
  const needsUser = valueOfEntry({ grader: "CGC", grade: null }, PIKACHU);
  const needsUs = valueOfEntry({ grader: null, grade: null }, PIKACHU);
  assert.notEqual(needsUser.unpriced, needsUs.unpriced);
});
