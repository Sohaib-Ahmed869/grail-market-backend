// Fixtures for the read path that now serves most scans.
//
// Prices come out of our own store rather than off a paid API on every scan,
// so the reshaping between the two is where a grader can quietly acquire a
// figure that was never measured for it. These pin the cases that would
// otherwise show a Beckett badge over a PSA number, or an empty figure that
// reads as "worthless" when it means "we don't know".
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradePointsFromStore, parseGradeKey } from "../src/scans/gradedprices.js";

test("a stored figure keeps its age, so nothing pretends to be live", () => {
  const out = gradePointsFromStore({
    PSA: { 10: { price: 4250, sampleSize: 412, fetchedAt: "2026-08-20T00:00:00.000Z" } },
  });
  assert.equal(out.PSA["10"].price, 4250);
  assert.equal(out.PSA["10"].count, 412);
  assert.equal(out.PSA["10"].asOf, "2026-08-20T00:00:00.000Z");
});

test("a grade we hold no price for is dropped, not shown as empty", () => {
  const out = gradePointsFromStore({
    PSA: { 9: { price: 900 }, 10: { price: null, sampleSize: 0 } },
  });
  assert.deepEqual(Object.keys(out.PSA), ["9"]);
});

test("a grader with nothing usable disappears rather than borrowing PSA's numbers", () => {
  const out = gradePointsFromStore({
    PSA: { 10: { price: 4250 } },
    BGS: { 9.5: { price: null } },
  });
  assert.deepEqual(Object.keys(out), ["PSA"]);
  assert.equal(out.BGS, undefined);
});

test("nothing usable at all is null, never an empty shell", () => {
  assert.equal(gradePointsFromStore({}), null);
  assert.equal(gradePointsFromStore({ BGS: { 9.5: { price: null } } }), null);
});

test("half grades survive the round trip — BGS 9.5 is not BGS 9", () => {
  const out = gradePointsFromStore({
    BGS: { 9: { price: 300 }, 9.5: { price: 1750 } },
  });
  assert.equal(out.BGS["9"].price, 300);
  assert.equal(out.BGS["9.5"].price, 1750);
});

// The refresh job keys everything it writes off this parser, so a key it
// misreads is a price filed under the wrong grading company.
test("grade keys carry their grading company, and ungraded is not a grade", () => {
  assert.deepEqual(parseGradeKey("bgs9_5"), { grader: "BGS", grade: "9.5" });
  assert.deepEqual(parseGradeKey("psa10"), { grader: "PSA", grade: "10" });
  assert.deepEqual(parseGradeKey("bccg10"), { grader: "BCCG", grade: "10" });
  assert.equal(parseGradeKey("ungraded"), null);
  assert.equal(parseGradeKey("marketPrice"), null);
});
