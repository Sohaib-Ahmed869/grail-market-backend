import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyShop, distanceKm, midpoint, rankShops } from "../src/meetups/places.js";

// Elements read off OpenStreetMap within 15 km of Parramatta, 14 Sep 2026.
const el = (shop, name, extra = {}) => ({ type: "node", lat: -33.8, lon: 151.0, tags: { shop, name, ...extra } });

test("card and game stores are kept; toy chains and model shops are not", () => {
  assert.equal(classifyShop(el("games", "Good Games")), "card");
  assert.equal(classifyShop(el("collector", "Card Konbini")), "card");
  assert.equal(classifyShop(el("games", "Chromatic Games")), "games");
  assert.equal(classifyShop(el("anime", "Anime at Abbotsford")), null);
  assert.equal(classifyShop(el("toys", "Smiggle")), null);
  assert.equal(classifyShop(el("toys", "Toys R Us")), null);
  assert.equal(classifyShop(el("hobby", "Model Railroad Craftsman")), null);
  assert.equal(classifyShop(el("collector", "The Bradford Exchange")), null);
  // A toy shop that says it sells cards is a card shop.
  assert.equal(classifyShop(el("toys", "Poke Cards & Toys")), "card");
  // Grading services are not a public place to meet.
  assert.equal(classifyShop(el("games", "PCG Premium Card Grading Australia")), null);
  assert.equal(classifyShop({ type: "node", lat: 1, lon: 1, tags: { shop: "games" } }), null);
});

test("distance and midpoint are right to within a kilometre", () => {
  const parramatta = { lat: -33.8150, lon: 151.0011 };
  const sydneyCbd = { lat: -33.8688, lon: 151.2093 };
  const d = distanceKm(parramatta, sydneyCbd);
  assert.ok(d > 19 && d < 21, `got ${d}`);
  const m = midpoint(parramatta, sydneyCbd);
  assert.ok(Math.abs(distanceKm(m, parramatta) - distanceKm(m, sydneyCbd)) < 1);
});

test("the fairest shop wins: close to both, card stores before general game stores", () => {
  const a = { lat: -33.8150, lon: 151.0011 }, b = { lat: -33.8688, lon: 151.2093 };
  const mid = midpoint(a, b);
  const near = { name: "Good Games Mid", kind: "card", lat: mid.lat, lon: mid.lon };
  const nearGames = { name: "Board Games Mid", kind: "games", lat: mid.lat + 0.001, lon: mid.lon };
  const nextToA = { name: "Card Shop At A", kind: "card", lat: a.lat, lon: a.lon };
  const ranked = rankShops([nextToA, nearGames, near], a, b).map((s) => s.name);
  assert.deepEqual(ranked, ["Good Games Mid", "Board Games Mid", "Card Shop At A"]);
});

import { tileOf, tilesAround } from "../src/meetups/places.js";

test("shops are saved by map tile, and a circle asks only for the tiles it touches", () => {
  assert.equal(tileOf({ lat: -33.81, lon: 151.0 }), "-34:151");
  assert.equal(tileOf({ lat: -33.4, lon: 151.2 }), "-33.5:151");
  const small = tilesAround({ lat: -33.75, lon: 151.25 }, 5);
  assert.equal(small.length, 1, "a small circle in the middle of a tile is one tile");
  const wide = tilesAround({ lat: -33.99, lon: 151.01 }, 20);
  assert.ok(wide.length >= 2 && wide.length <= 9);
});
