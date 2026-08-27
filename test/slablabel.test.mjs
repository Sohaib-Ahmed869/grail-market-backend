// Fixtures from grading labels that resolved to the wrong card.
//
// These hit the real catalogue, like setcode.test.mjs does, because the bug
// they pin is in how we choose between real sets — a stubbed catalogue would
// prove nothing about it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { identifyFromSlabLabel } from "../src/scans/tcgdex.js";

// BGS prints the set over TWO lines: an era header and the actual set.
//
//   2025 SCARLET & VIOLET
//   DESTINED RIVALS
//   #231 TEAM ROCKET'S MEWTWO
//   EX SIR
//
// The era line "SCARLET & VIOLET" is itself the exact name of a real set
// (sv01), and #231 exists in both. So the label matched sv01 at ~1.0, found
// Koraidon ex at #231, and shipped it — a completely different card, with the
// right grade on it, priced at A$69 for a card that is not the one in the slab.
//
// Every piece of information needed was already in hand: the more specific set
// was sitting in setCandidates, and the label named the card.
test("an era header does not beat the set printed under it", async () => {
  const out = await identifyFromSlabLabel({
    year: "2025",
    setLine: "SCARLET&VIOLET",
    setCandidates: [
      "SCARLET&VIOLET",
      "TEAMROCKET'SMEWTWO",
      "DESTINEDRIVALS",
      "ITEAMROCKET'SMEWTWO",
      "EXSIR",
    ],
    cardNumber: "231",
    name: "TEAMROCKET'SMEWTWO",
  });
  assert.ok(out, "the card is in the catalogue — refusing to answer is also wrong");
  const id = out.identification;
  assert.match(id.name, /Mewtwo/i, `got "${id.name}" — Koraidon ex is the old bug`);
  assert.doesNotMatch(id.name, /Koraidon/i);
  assert.match(String(id.setName), /Destined Rivals/i, `set was "${id.setName}"`);
});

// The counter-case, and the reason the override being abused above exists at
// all. A condensed label font shreds the name ("#100 CHARIZARD DS HOLO R" comes
// back as fragments), and a garbled name must NOT veto an exact number inside a
// confidently matched set — doing so once dropped a $58k Gold Star to fuzzy
// face-name matching and priced it at $15.
test("a shredded name still loses to an exact number in a matched set", async () => {
  const out = await identifyFromSlabLabel({
    year: "2006",
    setLine: "POKEMON DRAGON FRONTIERS",
    setCandidates: ["POKEMONDRAGONFRONTIERS", "DRAGONFRONTIERS"],
    cardNumber: "100",
    name: "CHARIZARDSTAR",
  });
  assert.ok(out, "an unreadable name must not cost us the card");
  assert.match(String(out.identification.setName), /Dragon Frontiers/i);
  assert.equal(out.identification.localId, "100");
});

// And the case neither of those may break: when the label's set genuinely is
// the era-named set, that set must still win.
test("the era-named set still wins when it really is the set", async () => {
  const out = await identifyFromSlabLabel({
    year: "2023",
    setLine: "SCARLET&VIOLET",
    setCandidates: ["SCARLET&VIOLET", "KORAIDONEX"],
    cardNumber: "231",
    name: "KORAIDONEX",
  });
  assert.ok(out, "sv01 #231 is a real card");
  assert.match(out.identification.name, /Koraidon/i);
});
