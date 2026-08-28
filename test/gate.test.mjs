// The load gate is what stands between a traffic spike and an out-of-memory
// kill, so its behaviour under saturation is pinned rather than assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate, GateSaturated } from "../src/scans/gate.js";
import { TtlCache } from "../src/scans/ttlcache.js";

const never = () => new Promise(() => {});
const settle = () => new Promise((r) => setImmediate(r));

test("concurrency is capped — the fourth caller waits, it does not run", async () => {
  const gate = new Gate(3, 10);
  let started = 0;
  for (let i = 0; i < 5; i++) void gate.run(async () => { started++; await never(); });
  await settle();
  assert.equal(started, 3, "only three may run at once");
  assert.deepEqual(gate.depth, { inflight: 3, queued: 2 });
});

test("a finished slot is handed to whoever waited longest", async () => {
  const gate = new Gate(1, 10);
  const order = [];
  let release;
  // every task blocks, so the slot only moves when we say so and the order of
  // arrival is the only thing that can decide who goes next
  void gate.run(async () => { order.push("first"); await new Promise((r) => (release = r)); });
  await settle();
  void gate.run(async () => { order.push("second"); await never(); });
  void gate.run(async () => { order.push("third"); await never(); });
  await settle();
  assert.deepEqual(order, ["first"], "the queue has not jumped the gate");
  release();
  await settle();
  await settle();
  assert.deepEqual(order, ["first", "second"], "oldest waiter goes next, not newest");
});

test("past the queue bound it refuses instead of queueing forever", async () => {
  const gate = new Gate(1, 2);
  for (let i = 0; i < 3; i++) void gate.run(never);
  await settle();
  assert.equal(gate.saturated, true);
  await assert.rejects(() => gate.run(async () => "late"), GateSaturated);
});

test("a slot is released even when the work throws", async () => {
  const gate = new Gate(1, 4);
  await assert.rejects(() => gate.run(async () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(gate.depth, { inflight: 0, queued: 0 });
  assert.equal(await gate.run(async () => "ok"), "ok");
});

test("the cache evicts the coldest entry instead of growing without bound", () => {
  const c = new TtlCache(60_000, 3);
  c.set("a", 1); c.set("b", 2); c.set("c", 3);
  c.get("a");            // touching 'a' makes 'b' the coldest
  c.set("d", 4);
  assert.equal(c.size, 3);
  assert.equal(c.get("b"), undefined, "coldest entry was evicted");
  assert.equal(c.get("a"), 1, "recently used entry survived");
  assert.equal(c.get("d"), 4);
});

test("an expired entry is deleted on read, not merely skipped", () => {
  const c = new TtlCache(-1, 10); // already expired
  c.set("a", 1);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.size, 0, "expired entries must not accumulate");
});

test("a cached null is a real answer, distinguishable from a miss", () => {
  const c = new TtlCache(60_000, 10);
  c.set("known-nothing", null);
  assert.equal(c.entry("known-nothing")?.v, null, "negative cache hit");
  assert.equal(c.entry("never-asked"), undefined, "a genuine miss");
});
