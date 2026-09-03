import { createHash, createPublicKey, createVerify } from "node:crypto";

// Verifying an identity token from Google or Apple.
//
// This is the one place in the system where a stranger hands us a string and
// we turn it into "you are this person". Everything about it is therefore
// written to fail closed: an unknown algorithm, an unknown key, a wrong
// audience, a missing expiry — every one of those is a rejection, never a
// shrug and a decode.
//
// It is deliberately not a library. The whole job is a base64url decode, an
// RSA verify and four comparisons, and the failure mode of getting it wrong
// is "anyone can sign in as anyone" — which is worth having in front of you
// rather than behind a version range.

export type Jwk = {
  kty: string; kid: string; use?: string; alg?: string;
  n: string; e: string;
};

export type Claims = {
  iss: string; aud: string | string[]; sub: string;
  exp: number; iat?: number; nonce?: string;
  email?: string; email_verified?: boolean | string;
  name?: string;
};

export type Verdict =
  | { ok: true; claims: Claims }
  | { ok: false; why: string };

const b64urlToBuf = (s: string) => Buffer.from(s, "base64url");

/** Split and decode, without trusting anything inside yet. */
export function decode(token: string): { header: any; claims: Claims; signed: string; sig: Buffer } | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64urlToBuf(parts[0]!).toString("utf8"));
    const claims = JSON.parse(b64urlToBuf(parts[1]!).toString("utf8"));
    return {
      header, claims,
      signed: `${parts[0]}.${parts[1]}`,
      sig: b64urlToBuf(parts[2]!),
    };
  } catch {
    return null;
  }
}

/** A JWK to a key node can verify with. */
export function keyFromJwk(jwk: Jwk) {
  return createPublicKey({ key: jwk as any, format: "jwk" });
}

/** Sixty seconds either way.
 *
 *  Phone clocks and server clocks disagree, and a token rejected for being
 *  one second early is a sign-in that fails for no reason a user can act on.
 *  A minute is far less than any token's lifetime, so it costs nothing. */
export const SKEW_MS = 60_000;

export function verify(
  token: string,
  opts: { keys: Jwk[]; issuers: string[]; audiences: string[]; now?: number },
): Verdict {
  const parsed = decode(token);
  if (!parsed) return { ok: false, why: "malformed" };
  const { header, claims, signed, sig } = parsed;

  // Only RS256. "alg": "none" is the oldest JWT attack there is, and an
  // allowlist of one is the only version of this rule that cannot be widened
  // by accident.
  if (header?.alg !== "RS256") return { ok: false, why: "bad-alg" };
  if (!header?.kid) return { ok: false, why: "no-kid" };

  const jwk = opts.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, why: "unknown-key" };

  let good = false;
  try {
    good = createVerify("RSA-SHA256").update(signed).verify(keyFromJwk(jwk), sig);
  } catch {
    return { ok: false, why: "bad-key" };
  }
  if (!good) return { ok: false, why: "bad-signature" };

  // Signature first, then the claims. Checking claims on an unverified token
  // means reasoning about values an attacker chose.
  if (!opts.issuers.includes(String(claims.iss))) return { ok: false, why: "bad-issuer" };

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.some((a) => opts.audiences.includes(String(a)))) {
    // The audience is what stops a token minted for somebody else's app from
    // signing somebody into ours.
    return { ok: false, why: "bad-audience" };
  }

  const now = opts.now ?? Date.now();
  if (!Number.isFinite(claims.exp)) return { ok: false, why: "no-expiry" };
  if (claims.exp * 1000 + SKEW_MS <= now) return { ok: false, why: "expired" };
  if (claims.iat != null && claims.iat * 1000 - SKEW_MS > now) {
    return { ok: false, why: "future" };
  }
  if (!claims.sub) return { ok: false, why: "no-subject" };

  return { ok: true, claims };
}

/** A stable, non-reversible id for a provider account.
 *
 *  The provider's `sub` is stored hashed with the provider name: it is an
 *  identifier belonging to Google or Apple, and a database of raw ones is a
 *  cross-service correlation table we have no reason to hold. */
export const providerKey = (provider: string, sub: string) =>
  createHash("sha256").update(`${provider}:${sub}`).digest("hex");
