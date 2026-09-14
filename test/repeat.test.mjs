// "If the same card appears several times over a few months, raise it for
// review." — GM001-59.
//
// A counterfeit is not one object. Somebody with a genuine card sells it once;
// somebody with a stack of reprints lists the same card every few weeks, and
// each listing is unremarkable on its own. The pattern only exists across
// time, which is precisely what a per-listing review cannot see.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  repeatVerdict, REPEAT_COUNT, REPEAT_WINDOW_DAYS,
} from "../src/admin/repeat.js";

const NOW = Date.UTC(2026, 8, 14);
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const row = (id, daysBack, status = "sold", sameCert = false, certNumber = null) => ({
  listingId: id, status, at: daysAgo(daysBack), certNumber, sameCert,
});

test("one previous listing of the same card is not a pattern", () => {
  const v = repeatVerdict([row("l1", 10)], NOW);
  assert.equal(v.level, "none");
  assert.equal(v.reason, null);
});

test("several over a few months raises a review", () => {
  const v = repeatVerdict([row("l1", 10), row("l2", 40)], NOW);
  assert.equal(v.level, "review");
  assert.match(v.reason, /listed 3 times/);
  assert.equal(v.occurrences, 2);
});

test("the window is a few months, not forever", () => {
  // The same three listings, but the older two are outside the window: a
  // seller who sold this card twice last year is not running a operation.
  const v = repeatVerdict(
    [row("l1", REPEAT_WINDOW_DAYS + 1), row("l2", 400)], NOW,
  );
  assert.equal(v.level, "none");
  assert.equal(v.occurrences, 0);
});

test("the window boundary is inclusive", () => {
  const v = repeatVerdict([row("l1", REPEAT_WINDOW_DAYS), row("l2", 5)], NOW);
  assert.equal(v.level, "review");
});

test("drafts do not count", () => {
  // A draft is somebody changing their mind. Counting them would flag exactly
  // the carefulness we want sellers to have.
  const v = repeatVerdict([row("l1", 5, "draft"), row("l2", 8, "draft")], NOW);
  assert.equal(v.level, "none");
});

test("withdrawn listings DO count", () => {
  // Pulling a listing after being asked about it does not undo the pattern.
  const v = repeatVerdict([row("l1", 5, "withdrawn"), row("l2", 8, "withdrawn")], NOW);
  assert.equal(v.level, "review");
});

test("a shared certificate is a contradiction, not a pattern", () => {
  // A grading company issues a cert to ONE physical slab. Two listings with
  // the same number cannot both be that card, and it needs no count and no
  // window to say so.
  const v = repeatVerdict([row("l9", 200, "sold", true, "12345678")], NOW);
  assert.equal(v.level, "conflict");
  assert.match(v.reason, /certificate number is on 2 listings/);
  assert.deepEqual(v.certClashes, ["l9"]);
});

test("a cert clash outranks everything, including the window", () => {
  // Old, withdrawn, and still decisive.
  const v = repeatVerdict([row("l9", 3000, "withdrawn", true, "999")], NOW);
  assert.equal(v.level, "conflict");
});

test("a cert clash is not diluted by ordinary repeats", () => {
  const v = repeatVerdict(
    [row("l1", 5), row("l2", 9), row("l9", 20, "live", true, "555")], NOW,
  );
  assert.equal(v.level, "conflict", "the contradiction is the finding, not the count");
});

test("nothing at all is none", () => {
  const v = repeatVerdict([], NOW);
  assert.deepEqual(v, { level: "none", reason: null, occurrences: 0, certClashes: [] });
});

test("the threshold counts the listing under review", () => {
  // REPEAT_COUNT is the total number of listings of this card, so it takes
  // REPEAT_COUNT - 1 others to reach it.
  const others = Array.from({ length: REPEAT_COUNT - 2 }, (_, i) => row(`x${i}`, i + 1));
  assert.equal(repeatVerdict(others, NOW).level, "none");
  assert.equal(repeatVerdict([...others, row("last", 4)], NOW).level, "review");
});
