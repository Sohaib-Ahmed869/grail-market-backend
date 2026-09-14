// Two id shapes that do not agree, and a phone that guessed between them.
//
// A SET is `<prefix>:<code>` — `optcg:OP13`. A CARD is `<prefix>-<id>` —
// `optcg-OP13-119`. The card page cut a card id at its last hyphen and asked
// for the front half as a set, which gives `optcg-OP13`: neither shape. Every
// One Piece card therefore opened onto a page with no name, and with no name
// there is no price either. Portgas D Ace is the first card on the board, so
// it was the first thing anybody tapped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setIdOfCard } from "../src/scans/games.js";

test("a One Piece card resolves to its set, with the colon", () => {
  assert.equal(setIdOfCard("optcg-OP13-119"), "optcg:OP13");
  assert.equal(setIdOfCard("optcg-EB02-028"), "optcg:EB02");
  assert.equal(setIdOfCard("optcg-ST01-001"), "optcg:ST01");
});

test("the old cut is not what this returns", () => {
  // The exact string the phone was asking for. If this ever equals it again,
  // the bug is back.
  assert.notEqual(setIdOfCard("optcg-OP13-119"), "optcg-OP13");
});

test("Pokemon still works, because it was the one that always did", () => {
  assert.equal(setIdOfCard("swsh7-215"), "swsh7");
  assert.equal(setIdOfCard("base1-4"), "base1");
  assert.equal(setIdOfCard("cel25-4"), "cel25");
  // A set code carrying its own hyphen still keeps the number off the end.
  assert.equal(setIdOfCard("sv03-5-118"), "sv03-5");
});

test("an opaque provider id admits it cannot say", () => {
  // Magic, Yu-Gi-Oh and Lorcana ids carry the provider's identifier and the
  // set is genuinely not in the string. A plausible-looking guess here would
  // put the bug back with the symptom hidden, so it returns null and the
  // caller looks the card up another way.
  assert.equal(setIdOfCard("mtg-0000a54c-8e97-4c56-8f2e-1dc2e0b1f0aa"), null);
  assert.equal(setIdOfCard("ygo-46986414"), null);
  assert.equal(setIdOfCard("lorcana-crd_2b8c9f11"), null);
});

test("nonsense does not become a set", () => {
  assert.equal(setIdOfCard(""), null);
  assert.equal(setIdOfCard("swsh7"), null, "a bare set is not a card id");
  assert.equal(setIdOfCard("-4"), null);
});
