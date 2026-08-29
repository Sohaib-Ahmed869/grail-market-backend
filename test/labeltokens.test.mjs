// Three cards in a row were mispriced the same way: the grading label said
// exactly what the card was, and we used it for the grade and threw the rest
// away. These pin the general fix rather than any one card.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  labelTokens,
  listingMatchesLabel,
  rawGradedDivergence,
} from "../src/scans/labeltokens.js";

// The real OCR from the PSA slab, glued exactly as the condensed font returns it.
const LUFFY_LABEL = ["ONEPIECEEN", "PSAMAGAZINEEXCLUSIVE", "MONKEYD.LUFFY", "GEMMT"];

test("the distinctive part of a glued label token survives", () => {
  const toks = labelTokens(LUFFY_LABEL, {
    name: "Monkey.D.Luffy",
    setName: "Awakening of the New Era",
  });
  assert.ok(
    toks.some((t) => t.includes("MAGAZINEEXCLUSIVE")),
    `got ${JSON.stringify(toks)}`,
  );
});

test("grading furniture and the card's own name distinguish nothing", () => {
  const toks = labelTokens(LUFFY_LABEL, {
    name: "Monkey.D.Luffy",
    setName: "Awakening of the New Era",
  });
  assert.ok(!toks.includes("GEMMT"), "grade words are not printings");
  assert.ok(!toks.includes("MONKEY"), "the card name is on every listing");
  assert.ok(!toks.includes("LUFFY"));
});

test("it separates the promo from the base card sharing its number", () => {
  const toks = labelTokens(LUFFY_LABEL, {
    name: "Monkey.D.Luffy",
    setName: "Awakening of the New Era",
  });
  // the card actually in the holder — around $615
  assert.equal(
    listingMatchesLabel(
      "2024 ONE PIECE PROMOS PSA MAGAZINE EXCLUSIVE #060 MONKEY D. LUFFY PSA 10",
      toks,
    ),
    true,
  );
  // the base Leader we priced it as — $0.65 raw, asks around $120
  assert.equal(
    listingMatchesLabel("Monkey D. Luffy OP05-060 One Piece LEADER PSA 10 GEM MINT", toks),
    false,
  );
  // a different promo line entirely, also sharing OP05-060
  assert.equal(
    listingMatchesLabel(
      "Monkey.D.Luffy (Sound Loader Vol. 1) OP05-060 One Piece Promotion Foil PSA 10",
      toks,
    ),
    false,
  );
});

test("a label with nothing distinctive on it narrows nothing", () => {
  // no false confidence when the label is just grader furniture
  const toks = labelTokens(["PSA", "GEM MT", "10"], { name: "Charizard" });
  assert.equal(listingMatchesLabel("Charizard Base Set PSA 10", toks), false);
});

test("a 65-cent card in a slab is a misidentification, not a bargain", () => {
  const d = rawGradedDivergence(0.65, 615);
  assert.equal(d.suspect, true);
  assert.match(d.reason, /same collector number/);
});

test("a genuine slab premium is not flagged", () => {
  // real cards do carry large graded premiums — this must not fire on them
  assert.equal(rawGradedDivergence(488.29, 1364).suspect, false);
  assert.equal(rawGradedDivergence(60, 1200).suspect, false);
});

test("missing figures never manufacture a warning", () => {
  assert.equal(rawGradedDivergence(null, 615).suspect, false);
  assert.equal(rawGradedDivergence(0.65, null).suspect, false);
  assert.equal(rawGradedDivergence(0, 615).suspect, false);
});

// ---- a card name is not the grade printed above it -------------------------

test("grading furniture never becomes the card name", async () => {
  const { NOT_A_NAME } = await import("../src/scans/scans.service.js");
  // exactly what OCR returned from the Crocodile slab, glued as it arrives
  const raw = ["GEMMT", "OFFLINEREGIONALFINALISTV2", "2023ONEPIECEPROMO", "Crocodile"];
  const kept = raw.filter((n) => !NOT_A_NAME.some((re) => re.test(n)));
  assert.ok(!kept.includes("GEMMT"), "GEM MT is a grade, not a Crocodile");
  assert.ok(!kept.includes("2023ONEPIECEPROMO"), "the year line is not a name");
  assert.ok(kept.includes("Crocodile"), "the actual card name survives");
});

test("a glued label line loses to a real name", async () => {
  const { pickDescribedName } = await import("../src/scans/scans.service.js");
  assert.equal(
    pickDescribedName(["OFFLINEREGIONALFINALISTV2", "Crocodile", "Impel Down"]),
    "Crocodile",
    "a 25-character run of capitals is a product line, not a card name",
  );
  // and a genuine multi-word caps name is still preferred when present
  assert.equal(pickDescribedName(["TOP TRUMPS", "LARA"]), "TOP TRUMPS");
});
