import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGUAGE_SQL, languageOfListing } from "../src/listings/store.js";

// A listing's language is the edition of the card it was listed against.
test("Japanese editions read as Japanese, whichever catalogue they came from", () => {
  assert.equal(languageOfListing("tcg-pokemonjp-709141", "pokemonjp"), "ja");
  assert.equal(languageOfListing("tcg-pokemonjp-709141", null), "ja");
  assert.equal(languageOfListing("lng-ja-mtg-62903b94", "lang:mtg:ja"), "ja");
});

test("other language editions are 'other', never English", () => {
  assert.equal(languageOfListing("lng-zh_tw-pk-SV5K-001", "lang:pokemon:zh-tw"), "other");
  assert.equal(languageOfListing("lng-fr-pk-sv01-001", null), "other");
});

test("everything else — including a listing with no catalogue id — is English", () => {
  assert.equal(languageOfListing("sv03.5-199", "pokemon"), "en");
  assert.equal(languageOfListing("optcg-OP13-119", "onepiece"), "en");
  assert.equal(languageOfListing(null, null), "en");
});

test("the three SQL filters exist for exactly the three languages", () => {
  assert.deepEqual(Object.keys(LANGUAGE_SQL).sort(), ["en", "ja", "other"]);
  // English must exclude both of the others, or a Japanese card appears under English too.
  assert.match(LANGUAGE_SQL.en, /pokemonjp/);
  assert.match(LANGUAGE_SQL.en, /lng-/);
});
