import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../src/scans/ttlcache.js";

// Paid lookups cached only in memory were bought again on every restart — on
// 14 Sep that spent the whole day's eBay catalogue allowance, and sports came
// back empty. A cache given a namespace keeps its entries across processes.
test("a persisted cache survives a new instance (a restart)", () => {
  const ns = `t-${Math.random()}`;
  new TtlCache(60_000, 10, ns).set("sport:baseball", [{ setId: "a" }]);
  const again = new TtlCache(60_000, 10, ns);
  assert.deepEqual(again.get("sport:baseball"), [{ setId: "a" }]);
});

test("a recorded null survives too, as a null and not a miss", () => {
  const ns = `t-${Math.random()}`;
  new TtlCache(60_000, 10, ns).set("art:x", null);
  const hit = new TtlCache(60_000, 10, ns).entry("art:x");
  assert.ok(hit);
  assert.equal(hit.v, null);
});

test("expired entries are misses, but stay readable as stale", async () => {
  const ns = `t-${Math.random()}`;
  const c = new TtlCache(5, 10, ns);
  c.set("k", 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.get("k"), undefined);
  assert.equal(new TtlCache(5, 10, ns).stale("k"), 1);
});

test("without a namespace nothing is written anywhere", () => {
  const c = new TtlCache(60_000, 10);
  c.set("k", 1);
  assert.equal(new TtlCache(60_000, 10).get("k"), undefined);
});
