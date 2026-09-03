// Showing alternatives only helps if the list is honest: the real card has to
// be in it, the same card must not appear three times, and a list of one must
// not imply there was a decision to make.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankedCandidates, OFFER_WITHIN, MAX_CANDIDATES } from "../src/scans/candidates.js";

const id = (o = {}) => ({
  cardId: "c1", name: "Charizard", setId: "base", setName: "Base Set",
  localId: "4", rarity: null, imageUrl: null, matchScore: 0.9,
  ocrName: "charizard", game: "pokemon",
  ...o,
});
const m = (o) => ({ identification: id(o), valuation: null });
const cardIds = (list) => list.map((c) => c.identification.cardId);

test("the chosen match leads, whatever order they arrive in", () => {
  const chosen = m({ cardId: "c2", matchScore: 0.7 });
  const out = rankedCandidates([m({ cardId: "c1", matchScore: 0.9 }), chosen], chosen);
  assert.deepEqual(cardIds(out), ["c2", "c1"], "the page's answer must be the list's first row");
});

test("the rest come best-first", () => {
  const chosen = m({ cardId: "a", matchScore: 0.9 });
  const out = rankedCandidates(
    [chosen, m({ cardId: "b", matchScore: 0.72 }), m({ cardId: "c", matchScore: 0.85 })],
    chosen,
  );
  assert.deepEqual(cardIds(out), ["a", "c", "b"]);
});

test("each candidate keeps the valuation the catalogue that found it returned", () => {
  // this is what makes choosing one a swap rather than another round trip
  const chosen = m({ cardId: "a", matchScore: 0.9 });
  const other = { ...m({ cardId: "b", matchScore: 0.85 }), valuation: { source: "ppt" } };
  const out = rankedCandidates([chosen, other], chosen);
  assert.equal(out[1].valuation.source, "ppt");
});

test("a distant match is noise with a radio button, so it is dropped", () => {
  const chosen = m({ cardId: "a", matchScore: 0.95 });
  const out = rankedCandidates(
    [chosen, m({ cardId: "far", matchScore: 0.95 - OFFER_WITHIN - 0.01 })],
    chosen,
  );
  assert.equal(out.length, 0, "one plausible answer is not a choice");
});

test("the cut is inclusive at the boundary", () => {
  const chosen = m({ cardId: "a", matchScore: 0.95 });
  const out = rankedCandidates(
    [chosen, m({ cardId: "edge", matchScore: 0.95 - OFFER_WITHIN })],
    chosen,
  );
  assert.equal(out.length, 2);
});

test("the same card from two catalogues appears once", () => {
  const chosen = m({ cardId: "c1", matchScore: 0.9 });
  const out = rankedCandidates([chosen, m({ cardId: "c1", matchScore: 0.88 })], chosen);
  assert.equal(out.length, 0, "a duplicate is not an alternative");
});

test("cards with no catalogue id are told apart by name, set and game", () => {
  const chosen = m({ cardId: "llm", name: "Pikachu", setName: "Jungle", matchScore: 0.8 });
  const out = rankedCandidates(
    [
      chosen,
      // same name, same set, no id — the same guess twice
      m({ cardId: "llm", name: "pikachu", setName: "jungle", matchScore: 0.79 }),
      // same name, different set — a genuinely different card, and the whole
      // reason a picker exists
      m({ cardId: "llm", name: "Pikachu", setName: "Base Set", matchScore: 0.78 }),
    ],
    chosen,
  );
  assert.equal(out.length, 2);
  assert.equal(out[1].identification.setName, "Base Set");
});

test("the list is capped, so it never becomes a way of not answering", () => {
  const chosen = m({ cardId: "a", matchScore: 0.95 });
  const many = Array.from({ length: 20 }, (_, i) =>
    m({ cardId: `x${i}`, matchScore: 0.94 - i * 0.001 }),
  );
  const out = rankedCandidates([chosen, ...many], chosen);
  assert.equal(out.length, MAX_CANDIDATES);
});

test("no alternatives at all is an empty list, not a list of one", () => {
  const chosen = m();
  assert.deepEqual(rankedCandidates([chosen], chosen), []);
  assert.deepEqual(rankedCandidates([], chosen), []);
});

test("a missing score is treated as zero rather than throwing", () => {
  const chosen = m({ cardId: "a", matchScore: undefined });
  const out = rankedCandidates([chosen, m({ cardId: "b", matchScore: undefined })], chosen);
  assert.equal(out.length, 2, "two unscored matches are still two answers");
});
