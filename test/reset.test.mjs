// A reset link is the one credential we hand out over an unauthenticated
// channel. These pin the three properties that keep that safe: it expires, it
// works once, and what we store cannot be turned back into a working link.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newResetToken, hashToken, tokenMatches, resetVerdict, RESET_TTL_MS,
} from "../src/auth/reset.js";

const NOW = 1_700_000_000_000;
const row = (o = {}) => ({
  token_hash: "h",
  expires_at: new Date(NOW + RESET_TTL_MS),
  used_at: null,
  ...o,
});

test("the stored value cannot be used as a link", () => {
  const { token, hash } = newResetToken();
  assert.notEqual(token, hash);
  assert.ok(!hash.includes(token), "the token must not be recoverable from the row");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(tokenMatches(token, hash));
});

test("two requests never produce the same token", () => {
  const seen = new Set(Array.from({ length: 200 }, () => newResetToken().token));
  assert.equal(seen.size, 200);
});

test("a token that does not match its row is rejected without throwing", () => {
  const { hash } = newResetToken();
  for (const bad of ["", "not-a-token", null, undefined, hash]) {
    assert.equal(tokenMatches(bad, hash), false, `accepted ${JSON.stringify(bad)}`);
  }
  // and a stored hash of the wrong shape is a failure, not a crash
  assert.equal(tokenMatches("x", null), false);
});

test("a link works once", () => {
  assert.deepEqual(resetVerdict(row(), "a-long-enough-password", NOW), { ok: true });
  assert.deepEqual(
    resetVerdict(row({ used_at: new Date(NOW) }), "a-long-enough-password", NOW),
    { ok: false, why: "used" },
  );
});

test("a link stops working, and the boundary is closed", () => {
  const expires = new Date(NOW + RESET_TTL_MS);
  assert.ok(resetVerdict(row({ expires_at: expires }), "a-long-enough-password", NOW).ok);
  assert.deepEqual(
    resetVerdict(row({ expires_at: expires }), "a-long-enough-password", NOW + RESET_TTL_MS),
    { ok: false, why: "expired" },
    "expiry must be exclusive — a link is not valid at the instant it lapses",
  );
});

test("an unknown token and a used one are separate reasons, for our logs only", () => {
  assert.deepEqual(resetVerdict(null, "a-long-enough-password", NOW), { ok: false, why: "unknown" });
  assert.deepEqual(resetVerdict(undefined, "a-long-enough-password", NOW), { ok: false, why: "unknown" });
});

test("a valid link is still not a way to set a two-character password", () => {
  assert.deepEqual(resetVerdict(row(), "short", NOW), { ok: false, why: "weak" });
  assert.deepEqual(resetVerdict(row(), "", NOW), { ok: false, why: "weak" });
});

test("expiry is checked before the password, so a stale link never reports 'weak'", () => {
  const r = resetVerdict(row({ expires_at: new Date(NOW - 1) }), "short", NOW);
  assert.equal(r.why, "expired", "the reason must describe the link, not the form");
});
