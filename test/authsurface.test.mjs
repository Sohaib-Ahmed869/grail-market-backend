// Two things that are invisible until they cost you an account: what the
// sign-in response actually contains, and what a half-finished sign-in can do.
import { test } from "node:test";
import assert from "node:assert/strict";

// Signing sessions with a key invented at boot is refused on purpose, so the
// test has to supply one. This runs after the imports — ESM hoists them — and
// works because tokens.ts reads the variable per call rather than at load.
process.env.AUTH_SECRET ??= "test-secret-not-used-anywhere-real";
import { mintToken } from "../src/auth/tokens.js";
import { callerId } from "../src/auth/auth.controller.js";

const req = (token) => ({ header: (h) => (h === "authorization" ? `Bearer ${token}` : undefined) });

test("an MFA challenge cannot be spent as a session token", () => {
  const challenge = mintToken("mfa:u_abc", 60_000);
  assert.equal(callerId(req(challenge)), null, "the second step is not optional");
  // and the ordinary case still works, so the guard is not just refusing
  assert.equal(callerId(req(mintToken("u_abc"))), "u_abc");
});

test("a missing or malformed header is nobody, never a throw", () => {
  assert.equal(callerId({ header: () => undefined }), null);
  assert.equal(callerId(req("")), null);
  assert.equal(callerId(req("garbage")), null);
  assert.equal(callerId(req("a.b.c")), null);
});

test("a token signed with a different secret is rejected", () => {
  const good = mintToken("u_abc");
  const tampered = good.slice(0, -4) + "AAAA";
  assert.equal(callerId(req(tampered)), null);
});
