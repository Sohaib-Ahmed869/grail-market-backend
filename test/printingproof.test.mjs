// A name is not a printing. Every case here is a real answer from a live
// catalogue on 2026-09-15, and every one of them was priced as the wrong card
// before this existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPriceable, readYgoSetCodes, ygoPrintingFor, ygoSetPrice,
  readMtgPrinting, readLorcanaPrinting, nameOnCard, pokemonNumberMatches,
} from "../src/scans/printingproof.js";

// TCGdex /sets, cardCount.official and .total, for the sets in these cases.
const SET_COUNTS = new Map([
  ["base1", [102, 102]],
  ["ex14", [100, 100]],   // Crystal Guardians
  ["sv03.5", [165, 207]], // 151
]);

test("a collector number has to match the set's size, not just the card's position", () => {
  // The live result that prompted this: "004/102" read off a Base Set
  // Charizard confirmed Crystal Guardians Charizard δ, which is 4/100.
  assert.equal(pokemonNumberMatches({ id: "ex14-4", localId: "4" }, "004/102", SET_COUNTS), false);
  assert.equal(pokemonNumberMatches({ id: "base1-4", localId: "4" }, "004/102", SET_COUNTS), true);
});

test("a secret rare numbered past the set still matches its set", () => {
  assert.equal(pokemonNumberMatches({ id: "sv03.5-173", localId: "173" }, "173/165", SET_COUNTS), true);
});

test("a set we fetched but do not know is not a match; no set list at all falls back to the number", () => {
  assert.equal(pokemonNumberMatches({ id: "zz9-4", localId: "4" }, "4/102", SET_COUNTS), false);
  assert.equal(pokemonNumberMatches({ id: "ex14-4", localId: "4" }, "4/102", null), true);
  assert.equal(pokemonNumberMatches({ id: "base1-4", localId: "4" }, null, SET_COUNTS), false);
});

// ygoprodeck, cardinfo.php?name=Blue-Eyes White Dragon — the printings that
// matter, as returned (78 in total). card_prices.tcgplayer_price was "0.13".
const BLUE_EYES_SETS = [
  { set_code: "CT13-EN008", set_name: "2016 Mega-Tins", set_rarity: "Ultra Rare", set_price: "74.49" },
  { set_code: "MP24-EN001", set_name: "25th Anniversary Tin: Dueling Mirrors", set_rarity: "Quarter Century Secret Rare", set_price: "0" },
  { set_code: "LOB-001", set_name: "Legend of Blue Eyes White Dragon", set_rarity: "Ultra Rare", set_price: "62.15" },
  { set_code: "LOB-E001", set_name: "Legend of Blue Eyes White Dragon", set_rarity: "Ultra Rare", set_price: "681.49" },
  { set_code: "LOB-EN001", set_name: "Legend of Blue Eyes White Dragon", set_rarity: "Ultra Rare", set_price: "0" },
  { set_code: "SDK-001", set_name: "Starter Deck: Kaiba", set_rarity: "Ultra Rare", set_price: "25.6" },
];

test("an unconfirmed printing is never priced, whatever catalogue it came from", () => {
  assert.equal(isPriceable({ cardId: "ygo-89631139", printingConfirmed: false }), false);
  assert.equal(isPriceable({ cardId: "base1-4", printingConfirmed: false }), false);
  assert.equal(isPriceable({ cardId: "base1-4", printingConfirmed: true }), true);
});

test("an AI-named or text-described card has nothing to price", () => {
  // Base Set Charizard named by the vision model was priced at US$504 by name.
  assert.equal(isPriceable({ cardId: "llm" }), false);
  assert.equal(isPriceable({ cardId: "described" }), false);
  assert.equal(isPriceable(null), false);
});

test("the exact-code paths that predate the flag stay priceable", () => {
  // slab label and set-code reads resolve one card by construction
  assert.equal(isPriceable({ cardId: "sv03.5-173" }), true);
});

test("the set code under the artwork picks the one printing it names", () => {
  const codes = readYgoSetCodes(["Blue-Eyes White Dragon", "LOB-001", "ATK/3000 DEF/2500"]);
  const p = ygoPrintingFor(BLUE_EYES_SETS, codes);
  assert.equal(p?.set_code, "LOB-001");
  assert.equal(ygoSetPrice(p), 62.15);
});

test("a region letter is a different printing, not a near match", () => {
  // LOB-E001 is the European first print at ten times LOB-001.
  const p = ygoPrintingFor(BLUE_EYES_SETS, readYgoSetCodes(["LOB-E001"]));
  assert.equal(p?.set_code, "LOB-E001");
  assert.equal(ygoSetPrice(p), 681.49);
  assert.equal(ygoPrintingFor(BLUE_EYES_SETS, readYgoSetCodes(["LOB-DE001"])), null);
});

test("no code read means no printing — never the first set in the list", () => {
  // The first set used to be taken, which is how LOB-001 became a 2016 tin.
  assert.equal(ygoPrintingFor(BLUE_EYES_SETS, readYgoSetCodes(["Blue-Eyes White Dragon", "ATK/3000"])), null);
});

test("a printing the catalogue holds no price for is unknown, not free", () => {
  assert.equal(ygoSetPrice(BLUE_EYES_SETS[4]), null); // LOB-EN001, set_price "0"
});

test("OCR spacing round the dash does not lose the code", () => {
  assert.deepEqual(readYgoSetCodes(["LOB - EN001"]), ["LOB-EN001"]);
});

test("a Magic set and collector number are read from both frame styles", () => {
  // Orcish Bowmasters: 6 printings from US$48 (ltr 103) to US$193 (hoc 59).
  const modern = readMtgPrinting(["R 0103", "LTR • EN", "Orcish Bowmasters"]);
  assert.deepEqual(modern.sets, ["LTR"]);
  assert.ok(modern.numbers.includes("103"), JSON.stringify(modern));
  const older = readMtgPrinting(["103/281 R", "LTR • EN"]);
  assert.ok(older.numbers.includes("103"));
});

test("Magic numbers without a set line prove nothing", () => {
  // power/toughness and the year are numbers too
  const r = readMtgPrinting(["1/2", "2023"]);
  assert.deepEqual(r.sets, []);
});

test("a Lorcana collector line gives number and set", () => {
  assert.deepEqual(readLorcanaPrinting(["103/204 • EN • 5"]), { number: "103", setCode: "5" });
  assert.equal(readLorcanaPrinting(["Elsa - Spirit of Winter"]), null);
});

test("the AI's player name has to be on the card", () => {
  // A Stephen Curry was named Trayce Jackson-Davis; the card read "SELECT".
  assert.equal(nameOnCard("Trayce Jackson-Davis", ["SELECT"]), false);
  assert.equal(nameOnCard("Stephen Curry", ["SELECT", "STEPHEN CURRY"]), true);
  // Messi was named Emre Demir from a card whose nameplate read "LIONEL MESSI"
  assert.equal(nameOnCard("Emre Demir", ["LIONEL MESSI", "TOPPS"]), false);
});

test("a surname survives OCR noise and suffixes", () => {
  assert.equal(nameOnCard("Patrick Mahomes II", ["PATRICK MAHOMESII"]), true);
  assert.equal(nameOnCard("Charizard", ["Charirard"]), true);
  assert.equal(nameOnCard("Kylian Mbappé", ["K. MBAPPE"]), true);
});
