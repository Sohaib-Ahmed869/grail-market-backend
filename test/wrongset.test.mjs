// A pool that is unanimously a different card.
//
// Every title here was returned live by eBay for "Meganium 001 MEP Black Star
// Promos" — card 001 of a brand-new promo set. Not one of them is that card:
// they are the main-set 010/132, a 2016 BREAKpoint 3/122, and a Mega Meganium
// ex from Ascended Heroes. The old code priced the promo from all twelve
// because the number filter and the set filter each found nothing and each
// declined to apply itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { numberInTitle, setInTitle, statesACardNumber } from "../src/scans/ebaylistings.js";

const POOL = [
  "Meganium 010/132 ~ Rare Holo English Near Mint",
  "Meganium 010/132 Rare Mega Evolution Pokemon Holo Near Mint",
  "Meganium 3/122 Holo Rare BREAKpoint Pokemon Lightly Played",
  "Meganium 010/132 ~ Reverse Holo English Near Mint",
  "Meganium 010/132 NM/M Holo Mega Evolution MEG",
  "Mega Meganium ex - 010/217 Ascended Heroes Double Rare Holo Pokemon - NM",
  "Mega Meganium EX 010/217 Double Rare Ascended Heroes NM",
  "LP Holofoil - Meganium MEG - 010/132 Mega Evolution",
  "Meganium 010/132 Rare Mega Evolution Pokemon Reverse Holo Near Mint",
  "Meganium 010/132 Reverse Holo Mega Evolution",
  "Pokémon TCG Pokémon Meganium Meganium Rare Holo",
  "Meganium 010/132 Rare Mega Evolution Pokemon Holo Near Mint",
];

test("not one of them is card 001", () => {
  for (const t of POOL) {
    assert.equal(numberInTitle(t, "001"), false, `matched 001: ${t}`);
  }
});

test("but they overwhelmingly DO say which card they are", () => {
  // this is what separates "the wrong pool" from "a quiet one"
  const named = POOL.filter(statesACardNumber);
  assert.ok(named.length >= 2);
  assert.ok(named.length >= POOL.length * 0.6, `only ${named.length} of ${POOL.length} named`);
});

test("a silent pool is not treated as a wrong one", () => {
  // sellers who never write a number tell us nothing either way, and blanking
  // those would take the price off cards we can price perfectly well
  const quiet = [
    "Pokemon Meganium Holo Rare Near Mint",
    "Meganium Pokemon Card English NM",
    "Meganium holographic pokemon trading card",
  ];
  assert.equal(quiet.filter(statesACardNumber).length, 0);
});

test("statesACardNumber knows a collector number from a year or a grade", () => {
  assert.equal(statesACardNumber("Charizard 4/102 Base Set"), true);
  assert.equal(statesACardNumber("Luffy OP13-119 Parallel"), true);
  assert.equal(statesACardNumber("Charizard 1999 PSA 10 Holo"), false);
  assert.equal(statesACardNumber("Pikachu 1st Edition Near Mint"), false);
});

test("the set filter also finds nothing, which is why the number had to catch it", () => {
  for (const t of POOL) {
    assert.equal(setInTitle(t, "MEP Black Star Promos"), false, `matched the set: ${t}`);
  }
});

test("a correct pool still prices", () => {
  const right = [
    "Meganium 001/089 MEP Black Star Promos Holo NM",
    "Pokemon Meganium 001/089 Mega Evolution Promo",
  ];
  assert.equal(right.filter((t) => numberInTitle(t, "001")).length, 2);
});

// ---- the form of a card ----------------------------------------------------
//
// Titles below are live eBay results for "Meganium MEP Black Star Promos" and
// for the Gold Star Charizard. The first group is a different card wearing the
// same name; the second is the same card, and the words that look like form
// markers are a set name, a rarity and a condition.
import { mentionsCard, sameForm } from "../src/scans/ebaylistings.js";

test("Mega Meganium ex is not Meganium", () => {
  const wrong = [
    "Mega Meganium ex - 010/217 Ascended Heroes Double Rare Holo Pokemon - NM",
    "Mega Meganium EX 010/217 Double Rare Ascended Heroes NM",
    "2025 Pokemon MEP Black Star Promos Mega Meganium ex #034",
    "Mega Meganium ex MEP034 - Mega Evolution Promos - Black Star Promo - NM",
  ];
  for (const t of wrong) {
    assert.equal(sameForm("Meganium", t), false, `admitted: ${t}`);
    assert.equal(mentionsCard(t, "Meganium"), false, `admitted: ${t}`);
  }
});

test("a plain Meganium is still a plain Meganium", () => {
  const right = "Meganium (Cosmos Holo) - MEP Black Star Promos - Non-Holo - #069 - NM";
  assert.equal(sameForm("Meganium", right), true);
  assert.equal(mentionsCard(right, "Meganium"), true);
});

test("a set called EX Dragon Frontiers does not make it an ex card", () => {
  // the regression this nearly caused: "EX" as a set word, "Star" as a rarity
  assert.equal(sameForm("Charizard ☆ δ", "2006 EX Dragon Frontiers Charizard Gold Star BGS 8.5"), true);
  assert.equal(sameForm("Charizard", "Charizard EX Dragon Frontiers Holo Excellent"), true);
});

test("the mismatch is caught in both directions", () => {
  assert.equal(sameForm("Charizard ex", "Charizard VMAX 020/189 Darkness Ablaze"), false);
  assert.equal(sameForm("Umbreon VMAX", "Umbreon V 189/203 Evolving Skies Alt Art"), false);
  assert.equal(sameForm("Umbreon VMAX", "Umbreon VMAX 215/203 Evolving Skies Alt Art"), true);
});

test("silence is not a mismatch", () => {
  // most sellers write the name and the number and nothing else
  assert.equal(sameForm("Charizard ex", "Charizard 4/102 Base Set Holo NM"), true);
  assert.equal(sameForm("Meganium", "Pokemon Meganium Holo Rare Near Mint"), true);
});
