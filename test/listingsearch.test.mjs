import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEARCH_TEXT_SQL, searchTerms } from "../src/listings/store.js";

// GM001-29: search on card name, set and number. The old box matched the
// whole phrase against name OR set, so "charizard base" found nothing — the
// name holds one word and the set the other.
test("words are matched separately, in any order, across name, set and number", () => {
  assert.deepEqual(searchTerms("Charizard  Base"), ["charizard", "base"]);
  assert.deepEqual(searchTerms("base charizard #4"), ["base", "charizard", "4"]);
  assert.match(SEARCH_TEXT_SQL, /card_name/);
  assert.match(SEARCH_TEXT_SQL, /set_name/);
  assert.match(SEARCH_TEXT_SQL, /card_number/);
});

test("a typed % or _ is a character, not a wildcard", () => {
  assert.deepEqual(searchTerms("100%"), ["100\\%"]);
  assert.deepEqual(searchTerms("op_13"), ["op\\_13"]);
});

test("empty and absurd input is bounded", () => {
  assert.deepEqual(searchTerms("   "), []);
  assert.equal(searchTerms("a b c d e f g h i j").length, 6);
  assert.equal(searchTerms("x".repeat(200))[0].length, 60);
});
