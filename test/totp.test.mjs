// TOTP is the one thing here where "looks right" is worthless — a code that is
// six digits and changes every thirty seconds can still be wrong in a way no
// manual test would catch. So it is pinned to RFC 6238's own vectors.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base32Encode, base32Decode, totp, verifyTotp, newSecret, otpauthUrl, recoveryCodes,
} from "../src/auth/totp.js";

// RFC 6238 Appendix B uses the ASCII seed "12345678901234567890".
const SEED = base32Encode(Buffer.from("12345678901234567890", "ascii"));

test("the RFC's own test vectors", () => {
  // time in seconds -> expected 8-digit code, truncated to our 6.
  const vectors = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];
  for (const [secs, want] of vectors) {
    assert.equal(totp(SEED, secs * 1000), want, `t=${secs}`);
  }
});

test("base32 survives a round trip, and the way people retype it", () => {
  const raw = Buffer.from("hello there world!!!", "ascii");
  assert.deepEqual(base32Decode(base32Encode(raw)), raw);
  const s = base32Encode(raw);
  // spaced in fours, lowercased, padded — all of these reach us from real apps
  const mangled = s.toLowerCase().replace(/(.{4})/g, "$1 ") + "====";
  assert.deepEqual(base32Decode(mangled), raw, "a retyped secret must still work");
});

test("a code from one step ago is accepted, one from ten minutes ago is not", () => {
  const now = 1_700_000_000_000;
  assert.ok(verifyTotp(SEED, totp(SEED, now), now));
  assert.ok(verifyTotp(SEED, totp(SEED, now - 30_000), now), "clock drift is not an attack");
  assert.ok(verifyTotp(SEED, totp(SEED, now + 30_000), now));
  assert.ok(!verifyTotp(SEED, totp(SEED, now - 600_000), now), "ten minutes stale must fail");
});

test("nothing that is not six digits is ever accepted", () => {
  const now = 1_700_000_000_000;
  for (const bad of ["", "12345", "1234567", "abcdef", null, undefined, "  "]) {
    assert.equal(verifyTotp(SEED, bad, now), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("a secret from another account does not open this one", () => {
  const now = 1_700_000_000_000;
  const other = newSecret();
  assert.ok(!verifyTotp(SEED, totp(other, now), now));
});

test("the enrolment URL carries everything an authenticator needs", () => {
  const u = otpauthUrl(SEED, "sam@example.com");
  assert.match(u, /^otpauth:\/\/totp\/GrailCard%3Asam%40example\.com\?/);
  const q = new URL(u.replace("otpauth://", "https://")).searchParams;
  assert.equal(q.get("secret"), SEED);
  assert.equal(q.get("issuer"), "GrailCard");
  assert.equal(q.get("digits"), "6");
  assert.equal(q.get("period"), "30");
});

test("recovery codes are distinct and not guessable from each other", () => {
  const codes = recoveryCodes(8);
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const c of codes) assert.match(c, /^[0-9A-F]{5}-[0-9A-F]{5}$/);
});
