// Image recognition's verdicts. The picture may name a card on its own only
// when the nearest render is close AND clearly ahead of every card with a
// different name; it may settle the PRINTING only when it is also ahead of the
// other printings of that name, because printings share artwork by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import { confidentMatch, pictureProvesPrinting, printingLead } from "../src/scans/imagematch.js";

const m = (cardId, name, score) => ({
  game: "pokemon", cardId, name, setId: null, setName: null, number: null, imageUrl: null, score,
});

test("a close match well ahead of other cards names the card", () => {
  const r = { matches: [m("base1-4", "Charizard", 0.82), m("base1-2", "Blastoise", 0.61)], margin: 0.21, indexSize: 10 };
  assert.equal(confidentMatch(r)?.cardId, "base1-4");
});

test("a distant best match names nothing", () => {
  const r = { matches: [m("base1-4", "Charizard", 0.41), m("base1-2", "Blastoise", 0.3)], margin: 0.11, indexSize: 10 };
  assert.equal(confidentMatch(r), null);
});

test("two different cards neck and neck name nothing", () => {
  const r = { matches: [m("sv1-1", "Pikachu", 0.8), m("sv1-2", "Raichu", 0.79)], margin: 0.01, indexSize: 10 };
  assert.equal(confidentMatch(r), null);
});

test("the printing is only proven with a lead over the other printings", () => {
  const close = { matches: [m("base1-4", "Charizard", 0.8), m("base2-4", "Charizard", 0.79), m("x", "Blastoise", 0.5)], margin: 0.3, indexSize: 10 };
  assert.equal(printingLead(close), 0.01);
  assert.equal(pictureProvesPrinting(close), false);
  const clear = { matches: [m("base1-4", "Charizard", 0.86), m("base2-4", "Charizard", 0.7)], margin: null, indexSize: 10 };
  assert.equal(pictureProvesPrinting(clear), true);
  const only = { matches: [m("base1-4", "Charizard", 0.86), m("x", "Blastoise", 0.5)], margin: 0.36, indexSize: 10 };
  assert.equal(printingLead(only), null);
  assert.equal(pictureProvesPrinting(only), true);
});
