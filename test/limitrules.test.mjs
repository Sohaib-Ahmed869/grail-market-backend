// The rules, not the counter.
//
// `limits.test.mjs` pins the sliding window itself. This pins the thing the
// window is pointed AT, which is where the damage was: registration was five
// an hour keyed on the address alone, so the fifth person to sign up from one
// address shut the door on everybody behind it for an hour. That address is
// not an edge case — it is a card show on venue wifi, an office, a suburb
// behind one carrier-grade NAT address, which is to say most of a launch.
//
// Sign-in had the same shape at six in fifteen minutes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "../src/limits/middleware.js";

/** A request as the middleware reads one: a path, a method, an address and
 *  a parsed body. Nothing else in it is touched. */
function req({ path, method = "POST", ip = "203.0.113.7", body = {} }) {
  return {
    path, method, body, ip,
    socket: { remoteAddress: ip },
    header: (n) =>
      n.toLowerCase() === "x-forwarded-for" ? ip
      : n.toLowerCase() === "authorization" ? ""
      : undefined,
  };
}

/** Runs one request and says whether it was allowed. */
function attempt(r) {
  let status = 200;
  let payload = null;
  let passed = false;
  const res = {
    setHeader() {},
    status(c) { status = c; return res; },
    json(b) { payload = b; return res; },
  };
  rateLimit(r, res, () => { passed = true; });
  return { ok: passed, status, retryAfterSec: payload?.retryAfterSec ?? null };
}

test("a crowd on one address can all register", () => {
  // Fifty people at a show, one wifi router, one public address between them.
  // Under the old rule the sixth was refused and told to wait an hour.
  const ip = "198.51.100.20";
  for (let i = 0; i < 50; i++) {
    const r = attempt(req({ path: "/auth/register", ip, body: { email: `person${i}@example.com` } }));
    assert.ok(r.ok, `registration ${i + 1} from a shared address should pass`);
  }
});

test("a script opening accounts in bulk is still stopped", () => {
  const ip = "198.51.100.21";
  let refusedAt = null;
  for (let i = 0; i < 400; i++) {
    const r = attempt(req({ path: "/auth/register", ip, body: { email: `bot${i}@example.com` } }));
    if (!r.ok) { refusedAt = i + 1; break; }
  }
  assert.ok(refusedAt !== null, "bulk registration must be refused eventually");
  assert.ok(refusedAt <= 100, `should stop well before a hundred, stopped at ${refusedAt}`);
});

test("guessing one password does not lock out the other people on that address", () => {
  const ip = "198.51.100.22";
  const victim = { email: "target@example.com", password: "no" };

  // Somebody works over one account until the door shuts on them.
  let shut = false;
  for (let i = 0; i < 12 && !shut; i++) {
    shut = !attempt(req({ path: "/auth/login", ip, body: victim })).ok;
  }
  assert.ok(shut, "repeated attempts on one account must be refused");

  // The person at the next desk, same address, different account, gets in.
  const bystander = attempt(
    req({ path: "/auth/login", ip, body: { email: "someone.else@example.com" } }),
  );
  assert.ok(bystander.ok, "a different account on the same address must not be caught");
});

test("varying the email does not walk around the per-account limit", () => {
  // The narrow key is only safe because a wide one sits behind it.
  const ip = "198.51.100.23";
  let refusedAt = null;
  for (let i = 0; i < 400; i++) {
    const r = attempt(req({ path: "/auth/login", ip, body: { email: `guess${i}@example.com` } }));
    if (!r.ok) { refusedAt = i + 1; break; }
  }
  assert.ok(refusedAt !== null, "a spray across many accounts must still be refused");
  assert.ok(refusedAt <= 200, `backstop should hold, stopped at ${refusedAt}`);
});

test("a request with no email in it is not an unlimited bucket", () => {
  // The fallback key is the address, so leaving the field out is not a way
  // through — it just shares one bucket with every other anonymous attempt.
  const ip = "198.51.100.24";
  let shut = false;
  for (let i = 0; i < 12 && !shut; i++) {
    shut = !attempt(req({ path: "/auth/login", ip, body: {} })).ok;
  }
  assert.ok(shut, "an email-less sign-in attempt must still be limited");
});

test("browsing is not limited at all", () => {
  for (let i = 0; i < 200; i++) {
    const r = attempt(req({ path: "/listings", method: "GET", ip: "198.51.100.25" }));
    assert.ok(r.ok, "reading the market must never be rate limited");
  }
});
