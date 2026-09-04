// Two printings of the same Pokemon, in the same set, ninety dollars apart.
//
// Every pricing block below was returned live by tcgdex on 2026-09-04 for the
// two cards a user compared by hand and read as one card. me02.5-010 is the
// Double Rare and me02.5-272 the Special Illustration Rare; the app showed the
// first and the Collectr link was the second, which is why the numbers looked
// like a bug and were not.
//
// They are the fixture because they are the exact shape this panel has to keep
// apart: same name, same set, same artwork subject, different product ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shopsFor, ebayShop } from "../src/scans/shops.js";

const DOUBLE_RARE = {
  cardmarket: {
    updated: "2026-09-03T22:49:47.676Z", unit: "EUR", idProduct: 869621,
    avg: 1.3, low: 0.2, trend: 1.12, avg30: 1.25,
  },
  tcgplayer: {
    unit: "USD", updated: "2026-09-03T22:50:13.459Z",
    holofoil: { productId: 675822, lowPrice: 0.67, midPrice: 1.2, highPrice: 14.99, marketPrice: 0.99 },
  },
};

const ILLUSTRATION_RARE = {
  cardmarket: {
    updated: "2026-09-03T22:49:47.771Z", unit: "EUR", idProduct: 869883,
    avg: 74.6, low: 41, trend: 78.07, avg30: 72.7,
  },
  tcgplayer: {
    unit: "USD", updated: "2026-09-03T22:50:13.459Z",
    holofoil: { productId: 676084, lowPrice: 76.37, midPrice: 88.2, highPrice: 950, marketPrice: 83.22 },
  },
};

/** Answer the one tcgdex card fetch shopsFor makes, and record what it asked
 *  for. The url is asserted on, because asking by catalogue id rather than by
 *  name is the entire reason this module cannot return the wrong printing. */
function stubTcgdex(byId) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const id = String(url).split("/").pop();
    if (!(id in byId)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ pricing: byId[id] }) };
  };
  return { asked, restore: () => { globalThis.fetch = real; } };
}

test("the two printings are priced apart, each from its own product page", async () => {
  const s = stubTcgdex({ "me02.5-010": DOUBLE_RARE, "me02.5-272": ILLUSTRATION_RARE });
  try {
    const cheap = await shopsFor("me02.5-010");
    const dear = await shopsFor("me02.5-272");

    const tpCheap = cheap.find((r) => r.id === "tcgplayer");
    const tpDear = dear.find((r) => r.id === "tcgplayer");
    assert.equal(tpCheap.price, 0.99);
    assert.equal(tpDear.price, 83.22);
    // Different pages, which is the check that matters: one product id for
    // both would be the wrong-card bug wearing a link.
    assert.equal(tpCheap.url, "https://www.tcgplayer.com/product/675822");
    assert.equal(tpDear.url, "https://www.tcgplayer.com/product/676084");
    assert.ok(s.asked.every((u) => u.includes("/cards/me02.5-")));
  } finally { s.restore(); }
});

test("market price leads, not the cheapest damaged copy or somebody's fantasy", async () => {
  const s = stubTcgdex({ "me02.5-272": ILLUSTRATION_RARE });
  try {
    const [tp] = (await shopsFor("me02.5-272")).filter((r) => r.id === "tcgplayer");
    // 950 is a real highPrice in this response and pricing from it would be
    // absurd; 76.37 is the cheapest copy in any condition.
    assert.equal(tp.price, 83.22);
    assert.equal(tp.basis, "market price");
    assert.equal(tp.low, 76.37);
  } finally { s.restore(); }
});

test("a currency is carried, never relabelled", async () => {
  const s = stubTcgdex({ "me02.5-272": ILLUSTRATION_RARE });
  try {
    const rows = await shopsFor("me02.5-272");
    assert.equal(rows.find((r) => r.id === "tcgplayer").currency, "USD");
    assert.equal(rows.find((r) => r.id === "cardmarket").currency, "EUR");
    // 78.07 EUR and 83.22 USD are within a few percent of each other, which is
    // exactly why quietly showing one as the other would never look wrong.
    assert.equal(rows.find((r) => r.id === "cardmarket").price, 78.07);
  } finally { s.restore(); }
});

test("a shop we cannot reach is a shop we say nothing about", async () => {
  const s = stubTcgdex({});
  try {
    assert.deepEqual(await shopsFor("me02.5-999"), []);
  } finally { s.restore(); }
  assert.deepEqual(await shopsFor(null), []);
  assert.deepEqual(await shopsFor(""), []);
});

test("no price is no row, rather than a zero", async () => {
  const s = stubTcgdex({
    "x-1": { tcgplayer: { unit: "USD", holofoil: { productId: 1, marketPrice: 0 } }, cardmarket: null },
  });
  try {
    assert.deepEqual(await shopsFor("x-1"), []);
  } finally { s.restore(); }
});

test("the eBay row links to the cheapest listing, not whichever came first", () => {
  const row = ebayShop({
    medianAsk: 118, askLow: 71.97, askHigh: 630,
    listings: [
      { url: "https://ebay/dear", price: 630 },
      { url: "https://ebay/cheap", price: 71.97 },
      { url: null, price: 1 },
    ],
  });
  assert.equal(row.kind, "live");
  assert.equal(row.count, 3);
  assert.equal(row.url, "https://ebay/cheap");
});

test("an empty ask pool is not a shop", () => {
  assert.equal(ebayShop(null), null);
  assert.equal(ebayShop({ medianAsk: null, askLow: null, askHigh: null, listings: [] }), null);
  // The guards upstream empty this pool when every listing is a different
  // card. A row built from it anyway would put the wrong card's price under a
  // heading that says you can buy it.
  assert.equal(ebayShop({ medianAsk: 195, askLow: 68, askHigh: 299, listings: [] }), null);
});
