import { test } from "node:test";
import assert from "node:assert/strict";
import { sealedFrom } from "../src/scans/sealed.js";

// Shapes read off tcgcsv group 23821 (Prismatic Evolutions), 2026-09-14.
const products = [
  { productId: 593294, name: "Prismatic Evolutions Booster Pack", imageUrl: "a", url: "u", number: null, rarity: null },
  { productId: 593324, name: "Prismatic Evolutions Pokemon Center Elite Trainer Box (Exclusive)", imageUrl: "b", url: "u", number: null, rarity: null },
  { productId: 593355, name: "Prismatic Evolutions Elite Trainer Box", imageUrl: "c", url: "u", number: null, rarity: null },
  { productId: 600001, name: "Umbreon ex", imageUrl: "d", url: "u", number: "161/131", rarity: "Special Illustration Rare" },
  { productId: 600002, name: "Prismatic Evolutions Code Card", imageUrl: null, url: "u", number: null, rarity: null },
];
const prices = [
  { productId: 593324, subTypeName: "Normal", marketPrice: 671.89, lowPrice: 640 },
  { productId: 593355, subTypeName: "Normal", marketPrice: 88.5, lowPrice: 80 },
  { productId: 600001, subTypeName: "Holofoil", marketPrice: 1200, lowPrice: 1100 },
];

test("a card is never sealed product, and a code card is not a product", () => {
  const ids = sealedFrom(products, prices).map((p) => p.productId);
  assert.deepEqual(ids, [593294, 593324, 593355]);
});

test("each product carries its own price by id — the two Elite Trainer Boxes stay apart", () => {
  const byId = Object.fromEntries(sealedFrom(products, prices).map((p) => [p.productId, p.marketUsd]));
  assert.equal(byId[593324], 671.89);
  assert.equal(byId[593355], 88.5);
});

test("no price is null, never zero", () => {
  const pack = sealedFrom(products, prices).find((p) => p.productId === 593294);
  assert.equal(pack.marketUsd, null);
});
