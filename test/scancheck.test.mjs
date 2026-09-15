// The scan checker's scoring. The scanner is held to never being confidently
// wrong, so the one number that must stay at zero is "verified and wrong" —
// these pin exactly what counts as verified and how every verdict is tallied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotOf, isVerified, outcomeOf, summarize, isVerdict } from "../src/admin/scancheck.store.js";
import { can } from "../src/admin/roles.js";

const scan = (ident, extra = {}) => ({
  status: "analyzed", rejection: null, identification: ident, valuation: null, candidates: [], ocrNames: [], ...extra,
});
const baseSet = { cardId: "base1-4", name: "Charizard", setName: "Base Set", localId: "4", game: "pokemon", matchScore: 0.95, printingConfirmed: true };

test("a proven catalogue printing on an accepted photo is verified", () => {
  assert.equal(isVerified(snapshotOf(scan(baseSet))), true);
});

test("an unproven printing, an AI name, a described card or a rejected photo is not", () => {
  assert.equal(isVerified(snapshotOf(scan({ ...baseSet, printingConfirmed: false }))), false);
  assert.equal(isVerified(snapshotOf(scan({ ...baseSet, cardId: "llm" }))), false);
  assert.equal(isVerified(snapshotOf(scan({ ...baseSet, cardId: "described" }))), false);
  assert.equal(isVerified(snapshotOf(scan(baseSet, { rejection: { reason: "too_blurry" } }))), false);
  assert.equal(isVerified(snapshotOf(scan(null))), false);
});

test("verdicts score by whether the scanner stood behind the answer", () => {
  const verified = snapshotOf(scan(baseSet));
  const unverified = snapshotOf(scan({ ...baseSet, printingConfirmed: false, setName: "", localId: "" }));
  assert.equal(outcomeOf(verified, "correct"), "verified-correct");
  assert.equal(outcomeOf(verified, "wrong"), "verified-wrong");
  assert.equal(outcomeOf(unverified, "correct"), "unverified-correct");
  assert.equal(outcomeOf(unverified, "wrong"), "unverified-wrong");
  assert.equal(outcomeOf(snapshotOf(scan(null)), "wrong"), "no-answer");
  assert.equal(outcomeOf(verified, "bad-photo"), "bad-photo");
  assert.equal(outcomeOf(verified, null), "unjudged");
});

test("precision counts only verified answers; coverage leaves bad photos out", () => {
  const v = snapshotOf(scan(baseSet));
  const u = snapshotOf(scan({ ...baseSet, printingConfirmed: false }));
  const s = summarize([
    { result: v, verdict: "correct" },
    { result: v, verdict: "correct" },
    { result: v, verdict: "wrong" },
    { result: u, verdict: "correct" },
    { result: v, verdict: "bad-photo" },
    { result: v, verdict: null },
  ]);
  assert.equal(s.overall.checks, 6);
  assert.equal(s.overall.judged, 5);
  assert.equal(s.overall.verifiedWrong, 1);
  assert.equal(s.overall.precision, 2 / 3);
  assert.equal(s.overall.coverage, 2 / 4);
  assert.equal(s.games.pokemon.checks, 6);
});

test("nothing judged means no rate at all, not zero", () => {
  const s = summarize([{ result: snapshotOf(scan(baseSet)), verdict: null }]);
  assert.equal(s.overall.precision, null);
  assert.equal(s.overall.coverage, null);
});

test("the snapshot keeps the price and its basis", () => {
  const s = snapshotOf(scan(baseSet, { valuation: { source: "tcgdex", tcgplayer: { unit: "USD", market: 882.02 } } }));
  assert.deepEqual(s.price, { value: 882.02, currency: "USD", basis: "tcgdex" });
});

test("only the three verdicts are accepted", () => {
  assert.equal(isVerdict("correct"), true);
  assert.equal(isVerdict("bad-photo"), true);
  assert.equal(isVerdict("maybe"), false);
});

test("owners and moderators can test scans; support desks cannot", () => {
  assert.equal(can("owner", "scans.test"), true);
  assert.equal(can("moderator", "scans.test"), true);
  assert.equal(can("tier-1", "scans.test"), false);
  assert.equal(can("member", "scans.test"), false);
});
