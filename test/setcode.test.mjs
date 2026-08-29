// Fixtures from the two PSA-graded Japanese cards our fuzzy matcher put in the
// wrong set: a A$1,500 Mega Charizard X ex SAR read as a $5 English Double Rare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSetCode, identifyBySetCode } from "../src/scans/setcode.js";

// exactly what the OCR returned for each card, label lines and card text
const CARD3 = ["2025POKEMONM2aJP", "#240", "MEGAGENGAReX", "GEMMT", "SPECIALARTRARE",
               "10", "144830132", "功竹力一ex", "350"];
const CARD4 = ["2025POKEMONM JP", "MEGACHARIZARDXeX", "GEMMT", "SPECIALARTRARE",
               "llus.danciao", "M2", "110/080SAR", "360"];

test("label spelling out the code wins", () => {
  const r = readSetCode(CARD3);
  assert.equal(r?.code, "M2a");
  assert.equal(r?.locale, "ja");
});

test("code read off the card when the label lost a digit", () => {
  // the label OCR'd as "POKEMONM JP" — the 2 of M2 did not survive. The card
  // prints the code itself in the bottom-left corner.
  const r = readSetCode(CARD4);
  assert.equal(r?.code, "M2");
  assert.equal(r?.number, "110");
  assert.equal(r?.printedNumber, "110/080");
  assert.equal(r?.rarity, "SAR");
});

test("an English card is never claimed as Japanese", () => {
  // no Japanese rarity suffix and no "<CODE> JP" — must decline
  assert.equal(readSetCode(["Charizard", "Base Set", "4/102", "PSA 9"]), null);
  assert.equal(readSetCode(["Pikachu", "#58", "Jungle", "1ST EDITION"]), null);
  assert.equal(readSetCode(["Stussy", "SPOP07-085SR", "CHARACTER"]), null);
});

test("no set code, no answer", () => {
  assert.equal(readSetCode([]), null);
  assert.equal(readSetCode(["240/193 SAR"]), null); // rarity but no code anywhere
});

test("resolves to the real card, not a similar-sounding one", { concurrency: false }, async () => {
  const r = readSetCode(CARD4);
  const id = await identifyBySetCode(r, "110", "Mega Charizard X ex");
  assert.equal(id?.cardId, "M2-110");
  assert.equal(id?.setId, "M2");
  assert.equal(id?.localId, "110/080");
  assert.equal(id?.rarity, "SAR");
  assert.equal(id?.matchScore, 1);
  // NOT the English Phantasmal Flames #013 the fuzzy matcher chose
  assert.notEqual(id?.setId, "me02");
});

test("resolves the second card too", { concurrency: false }, async () => {
  const id = await identifyBySetCode(readSetCode(CARD3), "240", "Mega Gengar ex");
  assert.equal(id?.cardId, "M2a-240");
  assert.equal(id?.setId, "M2a");
});

test("a code that does not exist resolves to nothing, never to a guess", async () => {
  const id = await identifyBySetCode(
    { code: "ZZ9", locale: "ja", number: "1", printedNumber: "1/1", rarity: "SAR" },
    "1", "Nothing",
  );
  assert.equal(id, null);
});

import { isSealedProduct } from "../src/scans/setcode.js";

test("a sealed pack is recognised through OCR's missing spaces", () => {
  // exactly the label lines the pack came back with
  assert.equal(isSealedProduct(["WOTC-POKEMON", "JUNGLEFOILPACK", "GEMMT", "IST -SCYTHER"]), true);
  assert.equal(isSealedProduct(["1999 WOTC POKEMON", "JUNGLE FOIL PACK"]), true);
  assert.equal(isSealedProduct(["POKEMON BOOSTER BOX", "BASE SET"]), true);
  // a single card must never be mistaken for sealed product
  assert.equal(isSealedProduct(["POKEMONM2aJP", "MEGAGENGAReX", "SPECIALARTRARE"]), false);
  assert.equal(isSealedProduct(["2025 ONE PIECE", "PORTGAS.D.ACE", "MANGA ART SEC"]), false);
  assert.equal(isSealedProduct([]), false);
});

import { labelDisplayName } from "../src/scans/scans.service.js";

test("the English name is recovered from whichever label line carries it", () => {
  // the slab reader had guessed "SPECIALARTRARE" was the name, so the English
  // name was lost and the card displayed as メガゲンガーex
  assert.equal(
    labelDisplayName({
      name: "SPECIALARTRARE",
      setCandidates: ["POKEMONM aJP", "SPECIALARTRARE", "MEGAGENGAReX", "GEMMT", "I B OI"],
    }),
    "Mega Gengar ex",
  );
  assert.equal(
    labelDisplayName({
      name: "MEGACHARIZARDXeX",
      setCandidates: ["POKEMONM JP", "MEGACHARIZARDXeX", "GEMMT", "SPECIALARTRARE"],
    }),
    // the form letter is its own word: "Charizardx" is not a card
    "Mega Charizard X ex",
  );
});

test("a name already correctly cased is left alone", () => {
  assert.equal(labelDisplayName({ name: "PORTGAS.D.ACE", setCandidates: [] }), "Portgas.D.Ace");
  assert.equal(labelDisplayName({ name: "Stussy", setCandidates: [] }), "Stussy");
});

test("grading furniture is never mistaken for a card name", () => {
  assert.equal(
    labelDisplayName({ name: "GEMMT", setCandidates: ["GEM MT", "PSA", "2025", "144830132"] }),
    null,
  );
  assert.equal(labelDisplayName(null), null);
});

import { readQuery } from "../src/scans/search.js";

test("a pasted marketplace title is pulled apart, not searched whole", () => {
  // exactly what a user pasted; every catalogue matches nothing as written
  assert.deepEqual(readQuery("Son Gohan : Adolescence - FB08-001 (Alternate Art)"), {
    name: "Son Gohan : Adolescence",
    code: "FB08-001",
    // the parenthetical is the printing — the difference between $2 and $200
    variant: "Alternate Art",
  });
  assert.deepEqual(readQuery("Umbreon VMAX"), { name: "Umbreon VMAX", code: null, variant: null });
  assert.equal(readQuery("OP13-119").code, "OP13-119");
  assert.equal(readQuery("Portgas.D.Ace (119) (Parallel) OP13-119").code, "OP13-119");
  assert.equal(readQuery("Portgas.D.Ace (119) (Parallel) OP13-119").name, "Portgas.D.Ace");
});

// One Piece prints its number on the card face, and OCR mangles it two ways at
// once: the zero becomes a letter O, and the number glues to the trait line
// above it. A Crocodile Offline Regional Finalist went out as "Unknown set"
// with the number sitting legibly in its own OCR the whole time.
test("a One Piece number survives O-for-zero and a glued trait line", async () => {
  const { readOnePieceCode } = await import("../src/scans/setcode.js");
  // exactly what OCR returned from the slab
  assert.equal(
    readOnePieceCode(["Impel Down/FormerBaroque Worksopo2-053"]),
    "OP02-053",
  );
  // and the clean cases still read
  assert.equal(readOnePieceCode(["OP05-060"]), "OP05-060");
  assert.equal(readOnePieceCode(["ST10-013B"]), "ST10-013");
  assert.equal(readOnePieceCode(["PRB02 005"]), "PRB02-005");
});

test("OCR noise is not read as a card number", async () => {
  const { readOnePieceCode } = await import("../src/scans/setcode.js");
  assert.equal(readOnePieceCode(["OPOO-OOO"]), null, "no real digits is noise");
  assert.equal(readOnePieceCode(["Crocodile"]), null);
  assert.equal(readOnePieceCode([]), null);
});
