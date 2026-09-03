import { TtlCache } from "../scans/ttlcache.js";
import { verify, type Claims, type Jwk } from "./jwt.js";

// Google and Apple, behind one shape.
//
// Both hand the app an OpenID identity token and both publish their signing
// keys at a JWKS endpoint. The only differences are the URLs, the issuers and
// what they put in the claims — so they are a table, not two code paths.

export type Provider = "google" | "apple";

type Config = {
  jwks: string;
  issuers: string[];
  /** Every client id that may appear in `aud`. iOS, Android and web each get
   *  their own from Google, and all three are legitimately ours. */
  audiences: () => string[];
};

const PROVIDERS: Record<Provider, Config> = {
  google: {
    jwks: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    audiences: () =>
      [
        process.env.GOOGLE_CLIENT_ID_IOS,
        process.env.GOOGLE_CLIENT_ID_ANDROID,
        process.env.GOOGLE_CLIENT_ID_WEB,
      ].filter((x): x is string => Boolean(x)),
  },
  apple: {
    jwks: "https://appleid.apple.com/auth/keys",
    issuers: ["https://appleid.apple.com"],
    // The bundle identifier for the native flow, and the Services ID if the
    // web flow is ever used.
    audiences: () =>
      [process.env.APPLE_BUNDLE_ID, process.env.APPLE_SERVICE_ID].filter(
        (x): x is string => Boolean(x),
      ),
  },
};

export const oauthConfigured = (p: Provider) => PROVIDERS[p].audiences().length > 0;

// Signing keys rotate, so they cannot be baked in — and they rotate slowly, so
// fetching them per sign-in would be a round trip for nothing. An hour is well
// inside both providers' rotation windows.
const keyCache = new TtlCache<Jwk[]>(60 * 60_000, 8);

async function keysFor(p: Provider): Promise<Jwk[]> {
  const hit = keyCache.get(p);
  if (hit) return hit;
  const res = await fetch(PROVIDERS[p].jwks, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`${p} jwks ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = (body.keys ?? []).filter((k) => k.kty === "RSA" && k.kid);
  if (!keys.length) throw new Error(`${p} jwks empty`);
  keyCache.set(p, keys);
  return keys;
}

export type Identity = {
  provider: Provider;
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
};

export type Result = { ok: true; identity: Identity } | { ok: false; why: string };

/** Verify an identity token and say who it belongs to.
 *
 *  `fallbackName` exists because Apple sends the person's name exactly once —
 *  on the very first authorisation, outside the token, in the response body.
 *  Miss it and you can never ask again, so the client passes it through and
 *  it is only ever used when the token itself has nothing. */
export async function verifyIdentity(
  provider: Provider,
  idToken: string,
  fallbackName?: string | null,
): Promise<Result> {
  const cfg = PROVIDERS[provider];
  const audiences = cfg.audiences();
  if (!audiences.length) return { ok: false, why: "not-configured" };

  let keys: Jwk[];
  try {
    keys = await keysFor(provider);
  } catch {
    // A provider we cannot reach is an outage, not a bad token. Saying so
    // stops it being reported to the user as "that didn't work".
    return { ok: false, why: "provider-unreachable" };
  }

  const v = verify(idToken, { keys, issuers: cfg.issuers, audiences });
  if (!v.ok) return { ok: false, why: v.why };

  const c: Claims = v.claims;
  // Google sends a boolean, Apple sends the string "true". Both mean the same
  // thing and neither is worth a branch at the call site.
  const verified = c.email_verified === true || c.email_verified === "true";
  return {
    ok: true,
    identity: {
      provider,
      sub: String(c.sub),
      email: c.email ? String(c.email).trim().toLowerCase() : null,
      emailVerified: verified,
      name: (c.name ?? fallbackName ?? null) || null,
    },
  };
}
