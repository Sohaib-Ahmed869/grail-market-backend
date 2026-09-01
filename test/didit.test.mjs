// The webhook is the only thing that can make somebody verified, so the guard
// on it is the security boundary of the whole identity feature. These pin the
// three ways a forged delivery gets in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { canonicalise, verifyWebhook } from "../src/identity/didit.js";

const SECRET = "test-secret";
const sign = (body) =>
  createHmac("sha256", SECRET).update(canonicalise(JSON.parse(body)), "utf8").digest("hex");

const body = JSON.stringify({
  event_id: "e1", status: "Approved", vendor_data: "user-1",
  decision: { face_matches: [{ score: 92.0 }] },
});

test("a genuine, fresh delivery verifies", () => {
  process.env.DIDIT_WEBHOOK_SECRET = SECRET;
  const now = Date.now();
  const r = verifyWebhook(body, sign(body), Math.floor(now / 1000), now);
  assert.deepEqual(r, { ok: true });
});

test("a whole-number float still verifies", () => {
  // Didit signs 92.0 as 92. Miss that and every payload carrying a round score
  // fails, which looks like a broken secret rather than a canonicalisation bug.
  process.env.DIDIT_WEBHOOK_SECRET = SECRET;
  const b = JSON.stringify({ event_id: "e2", score: 1.0, nested: { s: [2.0, 3.5] } });
  const now = Date.now();
  assert.deepEqual(verifyWebhook(b, sign(b), Math.floor(now / 1000), now), { ok: true });
});

test("key order does not change the signature", () => {
  process.env.DIDIT_WEBHOOK_SECRET = SECRET;
  const now = Date.now();
  const a = JSON.stringify({ b: 1, a: 2 });
  const reordered = JSON.stringify({ a: 2, b: 1 });
  assert.deepEqual(verifyWebhook(reordered, sign(a), Math.floor(now / 1000), now), { ok: true });
});

test("a replayed delivery is refused however good its signature", () => {
  // A valid signature stays valid forever. Without the freshness window,
  // anyone who captured one Approved webhook could verify any account, at will.
  process.env.DIDIT_WEBHOOK_SECRET = SECRET;
  const now = Date.now();
  const old = Math.floor(now / 1000) - 301;
  assert.deepEqual(verifyWebhook(body, sign(body), old, now), { ok: false, why: "stale" });
});

test("a forged signature is refused", () => {
  process.env.DIDIT_WEBHOOK_SECRET = SECRET;
  const now = Date.now();
  const bad = "0".repeat(64);
  assert.deepEqual(verifyWebhook(body, bad, Math.floor(now / 1000), now), {
    ok: false, why: "bad-signature",
  });
});

test("a tampered body is refused", () => {
  process.env.DIDIT_WEBHOOK_SECRET = SECRET;
  const now = Date.now();
  const sig = sign(body);                       // signed as user-1
  const swapped = body.replace("user-1", "user-2");   // delivered as user-2
  assert.deepEqual(verifyWebhook(swapped, sig, Math.floor(now / 1000), now), {
    ok: false, why: "bad-signature",
  });
});

test("no secret configured means nothing is trusted", () => {
  delete process.env.DIDIT_WEBHOOK_SECRET;
  const now = Date.now();
  assert.deepEqual(verifyWebhook(body, sign(body), Math.floor(now / 1000), now), {
    ok: false, why: "no-secret",
  });
});
