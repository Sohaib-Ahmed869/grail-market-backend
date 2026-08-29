// A search that returns the wrong cards is worse than one that returns none,
// because a median gets computed over it and shipped.
//
// The Gold Star Charizard searched as "100 BGS 8.5" — its name gone entirely —
// and priced from a Ken Griffey Jr, a Sean May jersey and an Eddie George.
// Median ask: A$11.06, on a card whose market is five figures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { latinName, mentionsCard } from "../src/scans/ebaylistings.js";

test("a decorative glyph does not cost us the whole name", () => {
  // ☆ and δ are part of how the catalogue writes it; "Charizard" is what every
  // seller types
  assert.equal(latinName("Charizard ☆ δ"), "Charizard");
  assert.equal(latinName("Umbreon VMAX"), "Umbreon VMAX");
  // accents fold to their base letter rather than vanishing — a seller typed
  // "Pokemon", and blanking the é searches for "Pok mon", which is nothing
  assert.equal(latinName("Pokémon Trainer"), "Pokemon Trainer");
});

test("a name with no usable Latin content is still dropped", () => {
  // the original rule was right about THIS case: a Japanese catalogue name
  // matches nothing an English-language seller wrote
  assert.equal(latinName("メガゲンガーex"), "");
  assert.equal(latinName("アーマードミュウツー"), "");
  assert.equal(latinName("☆"), "");
});

test("listings must actually mention the card to be comps for it", () => {
  assert.equal(mentionsCard("2006 EX Dragon Frontiers Charizard Gold Star BGS 8.5", "Charizard ☆ δ"), true);
  assert.equal(mentionsCard("Charizard δ Delta Species #100 BGS 8.5", "Charizard ☆ δ"), true);
  // the sports cards that set an A$11 median for a five-figure card
  assert.equal(mentionsCard("1992 BOWMAN #100 KEN GRIFFEY JR. BGS 8.5", "Charizard ☆ δ"), false);
  assert.equal(mentionsCard("2009 Score Red Zone #393 - Shonn Greene (RC) /100 BGS 8.5", "Charizard ☆ δ"), false);
  assert.equal(mentionsCard("2005-06 Topps Pristine Basketball #165 Sean May Jersey 37/100", "Charizard ☆ δ"), false);
});

test("a name we cannot check does not reject everything", () => {
  // with no usable name there is nothing to test against, and rejecting every
  // listing would be worse than not filtering
  assert.equal(mentionsCard("anything at all", "メガゲンガー"), true);
  assert.equal(mentionsCard("anything at all", ""), true);
});

test("a multi-card lot is not a comparable for one card", async () => {
  const { NOT_ONE_CARD } = await import("../src/scans/ebaylistings.js");
  // a $2,999 six-card lot sat among four single Finalists and dragged the
  // top of the range with it
  assert.ok(NOT_ONE_CARD.test("One Piece 2023 Offline Regional Finalist PSA 10 Set of 6 (Crocodile)"));
  assert.ok(NOT_ONE_CARD.test("Pokemon lot of 12 cards PSA 9"));
  // and a single card that merely mentions a set is untouched
  assert.ok(!NOT_ONE_CARD.test("PSA 10 Crocodile OP02-053 Offline Regional Finalist Promo"));
  assert.ok(!NOT_ONE_CARD.test("Charizard Base Set PSA 8"));
});
