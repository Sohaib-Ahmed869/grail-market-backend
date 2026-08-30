// A search that returns the wrong cards is worse than one that returns none,
// because a median gets computed over it and shipped.
//
// The Gold Star Charizard searched as "100 BGS 8.5" — its name gone entirely —
// and priced from a Ken Griffey Jr, a Sean May jersey and an Eddie George.
// Median ask: A$11.06, on a card whose market is five figures.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  latinName,
  mentionsCard,
  numberInTitle,
  setInTitle,
  setWords,
  searchableSetName,
} from "../src/scans/ebaylistings.js";

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

// The Charizard Gold Star, #100 of EX Dragon Frontiers. Asking for "100" used
// to return eleven other Charizards and one real one, because the filter
// stripped punctuation and looked for the digits anywhere in the title — so
// every card in a HUNDRED-CARD SET matched a card NUMBERED 100. The cheapest
// of the intruders then set the price and the card was quoted at A$379.
//
// These are the real titles eBay returned.
test("a set size is not a card number", () => {
  const wrong = [
    "Pokemon Graded: Charizard 4/100 EX Crystal Gaurdians (2006) Beckett 8.5",
    "Pokemon Charizard Holo Stormfront Stormfront 103/100 Ita BGS 8.5",
    "2007 Charizard Species Delta 04/100, Guardians Of the Crystals IT, BGS 8.5",
    "Charizard 4 / 100 EX Crystal Guardians Reverse Holo Beckett 8.5",
  ];
  for (const t of wrong) {
    assert.equal(numberInTitle(t, "100"), false, `denominator admitted: ${t}`);
  }
});

test("the card's own number still matches, however it is written", () => {
  const right = [
    "Pokémon - Charizard Gold Star 100 | EX Dragon Frontiers | BGS 8.5",
    "Pokemon Charizard Gold Star 100/101 Ex Dragon Frontiers BGS 8.5",
    "BGS 8.5 Charizard Gold Star Delta Species Holo Rare 100/101 EX Dragon",
    "2014 Pokemon XY Flashfire #100 Charizard EX Full Art BGS 8.5",
    "Charizard No. 100 EX Dragon Frontiers BGS 8.5",
  ];
  for (const t of right) {
    assert.equal(numberInTitle(t, "100"), true, `real number rejected: ${t}`);
  }
});

test("leading zeros are the same number", () => {
  assert.equal(numberInTitle("Luffy OP02-053 SA 10", "053"), true);
  assert.equal(numberInTitle("Luffy OP02-053 SA 10", "53"), true);
  // ...and a different number is still different
  assert.equal(numberInTitle("Luffy OP02-053 SA 10", "35"), false);
});

// Card 100 exists in three different Pokemon sets, and they are a $430 card, a
// $1,400 card and a $17,377 card. Once the number stops matching set sizes,
// these are what is left, and only the set name separates them.
test("a set that merely starts the same is a different set", () => {
  assert.equal(
    setInTitle("2003 Pokemon EX Dragon Charizard 100/97 Holo Beckett BGS 8.5", "Dragon Frontiers"),
    false,
    "EX Dragon is not EX Dragon Frontiers",
  );
  assert.equal(
    setInTitle("2014 Pokemon XY Flashfire #100 Charizard EX Full Art", "Dragon Frontiers"),
    false,
  );
  assert.equal(
    setInTitle("Pokémon - Charizard Gold Star 100 | EX Dragon Frontiers | BGS 8.5", "Dragon Frontiers"),
    true,
  );
  assert.equal(
    setInTitle("Pokemon Charizard Gold Star 100/101 Ex Dragon Frontiers BGS 8.5", "Dragon Frontiers"),
    true,
  );
});

test("structural words in a set name are not evidence", () => {
  // "EX" appears in half the titles on eBay and identifies nothing. If it were
  // required, a correct listing that omits it would be thrown away.
  assert.equal(setInTitle("Charizard Gold Star Dragon Frontiers 100/101", "EX Dragon Frontiers"), true);
});

// A PSA 10 Nami from the One Piece x Baskin Robbins campaign is a ~US$950
// card. We quoted A$98, off twelve listings for other people's Namis.
//
// eBay ranks a keyword search by relevance across every word given, so a term
// true of a hundred thousand listings does not narrow the search, it drowns
// it. Searching the full official set name returned 1,029 results with not one
// Baskin Robbins card among them; dropping the franchise returned nine, all of
// them the card.
test("the franchise is not a search term for a card inside it", () => {
  assert.equal(
    searchableSetName("One Piece x Baskin Robbins Campaign Collection Card", "onepiece"),
    "Baskin Robbins Campaign Collection Card",
  );
  // the crossover "x" is punctuation, not a word
  assert.equal(searchableSetName("Pokemon x Van Gogh Museum", "pokemon"), "Van Gogh Museum");
});

test("a set is only stripped of ITS OWN franchise", () => {
  // Dragon Frontiers is a Pokemon set and must keep both words; the same two
  // words in a Dragon Ball set are the franchise and must go.
  assert.equal(searchableSetName("Dragon Frontiers", "pokemon"), "Dragon Frontiers");
  assert.equal(searchableSetName("Dragon Ball Super Fusion World", "dragonball"), "Super Fusion World");
  assert.equal(searchableSetName("Dragon Frontiers", null), "Dragon Frontiers");
});

test("a set that is nothing but its franchise keeps its name", () => {
  // Stripping to nothing would search for the card with no set at all, which
  // is worse than searching with a weak one.
  assert.equal(searchableSetName("One Piece", "onepiece"), "One Piece");
});

test("set words drop the franchise and the filler", () => {
  const w = setWords("One Piece x Baskin Robbins Campaign Collection Card", "onepiece");
  assert.deepEqual(w, ["BASKIN", "ROBBINS", "CAMPAIGN", "COLLECTION"]);
  assert.deepEqual(setWords("Dragon Frontiers", "pokemon"), ["DRAGON", "FRONTIERS"]);
});
