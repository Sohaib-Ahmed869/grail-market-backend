// The failure this exists to stop is not a missing price, it is a wrong one:
// a real card's name and set printed against a completely different card's
// number, with that other card's chart under it. Every case here was taken
// from what the live feed actually answered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedMatches, suffixOf } from "../src/scans/feedmatch.js";

test("the case that started this: Lurantis ex is not Lurantis", () => {
  // asked for Lurantis ex / Pitch Black, feed returned Lurantis / Unified
  // Minds at about thirty cents against a hundred-dollar card
  const r = feedMatches(
    { name: "Lurantis ex", setName: "Pitch Black" },
    { name: "Lurantis", set: "sm-unified-minds-pokemon" },
  );
  assert.deepEqual(r, { ok: false, why: "suffix" });
});

test("every suffix that makes it a different card", () => {
  for (const suffix of ["ex", "GX", "V", "VMAX", "VSTAR"]) {
    const r = feedMatches(
      { name: `Charizard ${suffix}` },
      { name: "Charizard" },
    );
    assert.equal(r.ok, false, `${suffix} matched a plain Charizard`);
  }
  // and the other way round
  assert.equal(feedMatches({ name: "Charizard" }, { name: "Charizard ex" }).ok, false);
});

test("the same card with the same suffix matches", () => {
  const r = feedMatches(
    { name: "Umbreon VMAX", setName: "Evolving Skies" },
    { name: "Umbreon VMAX", set: "swsh07-evolving-skies-pokemon" },
  );
  assert.equal(r.ok, true);
});

test("a plain card matches a plain card", () => {
  const r = feedMatches(
    { name: "Charizard", setName: "Base Set" },
    { name: "Charizard", set: "base-set-pokemon" },
  );
  assert.equal(r.ok, true);
});

test("suffixOf finds the marker and only the marker", () => {
  assert.equal(suffixOf("Lurantis ex"), "ex");
  assert.equal(suffixOf("Umbreon VMAX"), "vmax");
  assert.equal(suffixOf("Charizard"), null);
  // "Mega Charizard X ex" ends in ex, and the X is not a suffix
  assert.equal(suffixOf("Mega Charizard X ex"), "ex");
  assert.equal(suffixOf(""), null);
});

test("a different card entirely is refused on the name", () => {
  const r = feedMatches({ name: "Blastoise" }, { name: "Charizard" });
  assert.deepEqual(r, { ok: false, why: "name" });
});

test("the same card in the wrong set is refused", () => {
  // same name, same suffix, but the feed answered about another printing —
  // Base Set Charizard and a Celebrations reprint differ by two orders
  const r = feedMatches(
    { name: "Charizard", setName: "Base Set" },
    { name: "Charizard", set: "cel25-celebrations-pokemon" },
  );
  assert.deepEqual(r, { ok: false, why: "set" });
});

test("a set we do not know is not held against the match", () => {
  // watchlist and collection rows carry no set, and refusing everything with
  // a blank set would drop cards we correctly identified
  const r = feedMatches({ name: "Charizard" }, { name: "Charizard", set: "anything" });
  assert.equal(r.ok, true);
  assert.equal(feedMatches({ name: "Charizard", setName: "Base Set" }, { name: "Charizard" }).ok, true);
});

test("punctuation and case do not decide a price", () => {
  assert.equal(
    feedMatches({ name: "Monkey.D.Luffy" }, { name: "Monkey D Luffy" }).ok,
    true,
  );
  assert.equal(feedMatches({ name: "PIKACHU" }, { name: "Pikachu" }).ok, true);
});
