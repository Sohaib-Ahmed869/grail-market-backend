// Naming a card no catalogue knows. The case that started this is real: a
// Topps Chrome LeBron James scanned on the live site on 2026-09-15 came back
// as "Pps" — OCR read PPS, TAKERS and LEBRON, and the first capitals won.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFurnitureWord, isFurnitureName, personNameFromTexts } from "../src/scans/describedname.js";

test("the LeBron card: a logo fragment and a misread team are not his name", async () => {
  const { pickDescribedName } = await import("../src/scans/scans.service.js");
  // what the live OCR returned, and the nameplate it read as two words
  const names = ["PPS", "TAKERS", "LEBRON"];
  const texts = ["PPS", "Chrome", "TAKERS", "23", "LEBRON", "JAMES"];
  assert.equal(pickDescribedName(names, texts), "LEBRON JAMES");
});

test("the same card read at another resolution: nothing usable among the banners", async () => {
  const { pickDescribedName } = await import("../src/scans/scans.service.js");
  // what the local OCR returned for a crop of the same card
  const names = ["LAKERS", "AKERS"];
  const texts = ["LAKERS", "23", "AKERS", "LEBRON", "JAMES", "AKERS", "LEBRON", "JAMES"];
  assert.equal(pickDescribedName(names, texts), "LEBRON JAMES");
});

test("brand words, their fragments and team names are furniture", () => {
  for (const w of ["TOPPS", "PPS", "OPPS", "Chrome", "PRIZM", "RIZM", "LAKERS", "AKERS", "TAKERS", "Yankees", "RC"]) {
    assert.equal(isFurnitureWord(w), true, w);
  }
  for (const w of ["LEBRON", "JAMES", "Crocodile", "Charizard", "MAHOMES"]) {
    assert.equal(isFurnitureWord(w), false, w);
  }
  assert.equal(isFurnitureName("TOPPS CHROME"), true);
  assert.equal(isFurnitureName("Impel Down"), false);
});

test("a name suffix stays with the name", () => {
  assert.equal(personNameFromTexts(["PATRICK", "MAHOMES", "II", "CHIEFS"]), "PATRICK MAHOMES II");
});

test("no two name-like words in a row means no person name", () => {
  assert.equal(personNameFromTexts(["TOPPS", "23", "LAKERS"]), null);
  assert.equal(personNameFromTexts([]), null);
});

test("existing behaviour holds when there is no nameplate to find", async () => {
  const { pickDescribedName } = await import("../src/scans/scans.service.js");
  assert.equal(pickDescribedName(["OFFLINEREGIONALFINALISTV2", "Crocodile", "Impel Down"]), "Crocodile");
  assert.equal(pickDescribedName(["TOP TRUMPS", "LARA"]), "TOP TRUMPS");
});
