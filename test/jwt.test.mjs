// The one place a stranger hands us a string and we turn it into "you are
// this person". Every test here is an attack that has worked on somebody
// else's login: alg=none, a token minted for another app, an expired one, a
// signature from a key we do not trust.
//
// Real RSA keys and real signatures — a fixture of a hand-written token would
// only prove the parser works on tokens we already believed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, randomUUID } from "node:crypto";
import { verify, decode, providerKey, SKEW_MS } from "../src/auth/jwt.js";

const NOW = 1_800_000_000_000;

function makeKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  return { jwk, privateKey, kid };
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function sign(key, claims, header = {}) {
  const h = b64({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const p = b64(claims);
  const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(key.privateKey);
  return `${h}.${p}.${sig.toString("base64url")}`;
}

const KEY = makeKey("k1");
const OTHER = makeKey("k2");

const claims = (o = {}) => ({
  iss: "https://accounts.google.com",
  aud: "our-client-id",
  sub: "user-123",
  exp: Math.floor(NOW / 1000) + 3600,
  iat: Math.floor(NOW / 1000) - 10,
  email: "sam@example.com",
  email_verified: true,
  ...o,
});

const opts = (o = {}) => ({
  keys: [KEY.jwk],
  issuers: ["https://accounts.google.com"],
  audiences: ["our-client-id"],
  now: NOW,
  ...o,
});

test("a properly signed token from the right issuer is accepted", () => {
  const r = verify(sign(KEY, claims()), opts());
  assert.equal(r.ok, true, r.why);
  assert.equal(r.claims.sub, "user-123");
  assert.equal(r.claims.email, "sam@example.com");
});

test('alg "none" is refused — the oldest JWT attack there is', () => {
  const h = b64({ alg: "none", kid: "k1", typ: "JWT" });
  const p = b64(claims());
  assert.deepEqual(verify(`${h}.${p}.`, opts()), { ok: false, why: "bad-alg" });
});

test("an HMAC token signed with the public key as the secret is refused", () => {
  // the other classic: flip RS256 to HS256 and sign with the key everyone has
  const h = b64({ alg: "HS256", kid: "k1", typ: "JWT" });
  const p = b64(claims());
  assert.equal(verify(`${h}.${p}.anything`, opts()).why, "bad-alg");
});

test("a signature from a key we do not trust is refused", () => {
  // signed with OTHER's private key but claiming k1, so the kid resolves and
  // the signature must be what rejects it
  const forged = sign({ ...OTHER, kid: "k1" }, claims());
  assert.deepEqual(verify(forged, opts()), { ok: false, why: "bad-signature" });
});

test("a key id we have never seen is refused rather than tried against all", () => {
  assert.deepEqual(verify(sign(OTHER, claims()), opts()), { ok: false, why: "unknown-key" });
});

test("a token minted for another app cannot sign anyone in here", () => {
  const r = verify(sign(KEY, claims({ aud: "some-other-app" })), opts());
  assert.deepEqual(r, { ok: false, why: "bad-audience" });
});

test("an array audience is accepted when ours is in it", () => {
  const r = verify(sign(KEY, claims({ aud: ["someone-else", "our-client-id"] })), opts());
  assert.equal(r.ok, true, r.why);
});

test("an issuer we do not recognise is refused", () => {
  const r = verify(sign(KEY, claims({ iss: "https://evil.example" })), opts());
  assert.deepEqual(r, { ok: false, why: "bad-issuer" });
});

test("expiry is enforced, with a minute of clock skew and no more", () => {
  const exp = Math.floor(NOW / 1000);
  // exactly at expiry, inside the skew window
  assert.equal(verify(sign(KEY, claims({ exp })), opts()).ok, true);
  // a minute past it, still inside
  assert.equal(verify(sign(KEY, claims({ exp })), opts({ now: NOW + SKEW_MS - 1 })).ok, true);
  // past the skew
  assert.equal(
    verify(sign(KEY, claims({ exp })), opts({ now: NOW + SKEW_MS + 1 })).why,
    "expired",
  );
});

test("a token with no expiry at all is refused, not treated as forever", () => {
  const c = claims();
  delete c.exp;
  assert.deepEqual(verify(sign(KEY, c), opts()), { ok: false, why: "no-expiry" });
});

test("a token issued in the future is refused", () => {
  const iat = Math.floor(NOW / 1000) + 600;
  assert.equal(verify(sign(KEY, claims({ iat })), opts()).why, "future");
});

test("a token with no subject is refused — there is nobody to be", () => {
  const c = claims();
  delete c.sub;
  assert.deepEqual(verify(sign(KEY, c), opts()), { ok: false, why: "no-subject" });
});

test("rubbish input is a rejection, never a throw", () => {
  for (const bad of ["", "a.b", "a.b.c", "...", null, undefined, "not a token at all"]) {
    const r = verify(bad, opts());
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(decode("nonsense"), null);
});

test("claims are only read after the signature checks out", () => {
  // a token whose payload claims the right issuer and audience but is signed
  // by nobody we trust must fail on the SIGNATURE, not sail past to a claim
  // check that happens to also fail
  const forged = sign({ ...OTHER, kid: "k1" }, claims({ iss: "https://evil.example" }));
  assert.equal(verify(forged, opts()).why, "bad-signature");
});

test("the provider id we store is not the provider's id", () => {
  const a = providerKey("google", "user-123");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(!a.includes("user-123"));
  // stable for the same input, and different across providers, so the same
  // person on Google and Apple is not silently one account
  assert.equal(a, providerKey("google", "user-123"));
  assert.notEqual(a, providerKey("apple", "user-123"));
});
