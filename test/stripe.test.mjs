// The billing webhook is what grants a paid plan, so its guard is the boundary
// between "someone paid" and "someone said they paid".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyStripe } from "../src/billing/stripe.js";

const SECRET = "whsec_test";
const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
const head = (ts, raw = body, secret = SECRET) =>
  `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${raw}`, "utf8").digest("hex")}`;

test("a genuine, fresh event verifies", () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const now = Date.now();
  assert.deepEqual(verifyStripe(body, head(Math.floor(now / 1000)), now), { ok: true });
});

test("an old event is refused even with a perfect signature", () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const now = Date.now();
  const old = Math.floor(now / 1000) - 400;
  assert.deepEqual(verifyStripe(body, head(old), now), { ok: false, why: "stale" });
});

test("a signature from the wrong secret is refused", () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const now = Date.now();
  const wrong = head(Math.floor(now / 1000), body, "whsec_someone_else");
  assert.deepEqual(verifyStripe(body, wrong, now), { ok: false, why: "bad-signature" });
});

test("a tampered body is refused", () => {
  // signed as a $10 plan, delivered claiming the $20 one
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const signed = JSON.stringify({ id: "evt_2", plan: "collector" });
  const swapped = JSON.stringify({ id: "evt_2", plan: "dealer" });
  assert.deepEqual(verifyStripe(swapped, head(ts, signed), now), {
    ok: false, why: "bad-signature",
  });
});

test("a header without a v1 scheme is refused, not crashed on", () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const now = Date.now();
  assert.deepEqual(verifyStripe(body, `t=${Math.floor(now / 1000)}`, now), {
    ok: false, why: "malformed",
  });
  assert.deepEqual(verifyStripe(body, "", now), { ok: false, why: "malformed" });
});

test("no secret configured means nothing is trusted", () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const now = Date.now();
  assert.deepEqual(verifyStripe(body, head(Math.floor(now / 1000)), now), {
    ok: false, why: "no-secret",
  });
});
