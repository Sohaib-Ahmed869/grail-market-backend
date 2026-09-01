// Passwords and session tokens. Everything a member owns — a verified
// identity, a paid plan — hangs off these two, so the failure modes matter
// more than the happy path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/auth/passwords.js";
import { mintToken, readToken } from "../src/auth/tokens.js";

test("the same password hashes differently every time", async () => {
  // A per-password salt is what stops one rainbow table cracking the column,
  // and what stops two members with the same password looking identical.
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.notEqual(a, b);
  assert.ok(await verifyPassword("correct horse battery", a));
  assert.ok(await verifyPassword("correct horse battery", b));
});

test("a wrong password does not verify", async () => {
  const h = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse batteries", h), false);
  assert.equal(await verifyPassword("", h), false);
});

test("a malformed stored hash fails rather than throws", async () => {
  // A row that is not the shape we expect is a failed login, never a 500 —
  // an endpoint that crashes on a bad row tells an attacker it is interesting.
  for (const junk of ["", "nonsense", "no-colon-here", "a:", ":b"]) {
    assert.equal(await verifyPassword("anything", junk), false, junk);
  }
});

test("a token round-trips to the user who was issued it", () => {
  process.env.AUTH_SECRET = "test-secret";
  const t = mintToken("u_abc");
  assert.deepEqual(readToken(t), { ok: true, userId: "u_abc" });
});

test("an expired token is refused", () => {
  process.env.AUTH_SECRET = "test-secret";
  assert.deepEqual(readToken(mintToken("u_abc", -1000)), { ok: false, why: "expired" });
});

test("a token signed with another secret is refused", () => {
  process.env.AUTH_SECRET = "test-secret";
  const t = mintToken("u_abc");
  process.env.AUTH_SECRET = "someone-elses-secret";
  assert.deepEqual(readToken(t), { ok: false, why: "bad-signature" });
});

test("editing the user id in a token invalidates it", () => {
  // The whole point: a token is not a claim, it is a signed claim.
  process.env.AUTH_SECRET = "test-secret";
  const [, exp, sig] = mintToken("u_abc").split(".");
  assert.deepEqual(readToken(`u_victim.${exp}.${sig}`), { ok: false, why: "bad-signature" });
});

test("garbage is malformed, not a crash", () => {
  process.env.AUTH_SECRET = "test-secret";
  for (const junk of ["", "a", "a.b", "....", "a.b.c.d"]) {
    assert.equal(readToken(junk).ok, false, junk);
  }
});
