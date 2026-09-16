// "Listed from" on a sports tile: the cheapest single copy of a player in a set
// for sale right now. Asked for on 2026-09-15 after the tiles said "open for
// listings" with no figure at all. It is a fact about the live market, never a
// value for the card — but it must be a copy OF THIS PLAYER, and one card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lowestAsk } from "../src/scans/sports.js";

const item = (title, value, currency = "USD") => ({ title, price: { value: String(value), currency } });

test("the cheapest single copy that names the player", () => {
  const items = [
    item("2024 Topps Chrome Stephen Curry #1 Refractor", 12.5),
    item("2024 Topps Chrome Stephen Curry Base", 3.99),
    item("2024 Topps Chrome Stephen Curry Gold /50", 150),
  ];
  assert.deepEqual(lowestAsk(items, "Stephen Curry"), { price: 3.99, currency: "USD" });
});

test("lots, pick lists and a different player are not a copy of this card", () => {
  const items = [
    item("2024 Topps Chrome lot of 20 Stephen Curry Durant James", 1),
    item("2024 Topps Chrome You Pick Stephen Curry LeBron James", 0.99),
    // one surname, two players
    item("2024 Topps Chrome Seth Curry", 0.5),
  ];
  assert.equal(lowestAsk(items, "Stephen Curry"), null);
});

test("a second currency is not compared with the first", () => {
  const items = [
    item("Stephen Curry 2024 Topps Chrome", 10, "USD"),
    item("Stephen Curry 2024 Topps Chrome", 5, "AUD"),
  ];
  assert.deepEqual(lowestAsk(items, "Stephen Curry"), { price: 10, currency: "USD" });
});

test("no usable price is no ask, never a zero", () => {
  const items = [item("Stephen Curry 2024 Topps Chrome", 0), { title: "Stephen Curry 2024 Topps Chrome" }];
  assert.equal(lowestAsk(items, "Stephen Curry"), null);
});
