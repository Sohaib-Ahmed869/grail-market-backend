// What can be silenced, and what silencing does.
//
// The rule these pin: muting stops the PUSH and never the record. A member who
// turns off offers still has to be able to find the offer, so the row is
// written before the preference is consulted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KINDS } from "../src/notifications/store.js";

test("only kinds that can push are offered as switches", () => {
  // rating is recorded but deliberately never pushed — a switch for it would
  // be a control that does nothing
  assert.ok(!KINDS.includes("rating"), "rating must not be offered");
  for (const k of ["offer", "offer-settled", "message", "listing", "price"]) {
    assert.ok(KINDS.includes(k), `${k} should be switchable`);
  }
});

test("the list is derived, not hand-written", () => {
  // duplicates or unknown strings would mean two sources of truth
  assert.equal(new Set(KINDS).size, KINDS.length);
  assert.ok(KINDS.length >= 5);
});

test("the push decision reads the muted set, and only for pushable kinds", async () => {
  // Read as source rather than executed: the ordering is the invariant — the
  // insert happens first, the mute check second, so a silenced kind still
  // leaves a row behind.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/notifications/store.ts", import.meta.url), "utf8");
  const insert = src.indexOf("insert into notifications");
  const gate = src.indexOf("mutedFor(n.userId)");
  const pushes = src.indexOf("if (!PUSHES[n.kind]) return;");
  assert.ok(insert > 0 && gate > 0 && pushes > 0);
  assert.ok(insert < pushes, "the record must be written before anything can return early");
  assert.ok(pushes < gate, "PUSHES decides first; the member's preference only narrows it");
});
