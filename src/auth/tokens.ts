import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Session tokens: `userId.expiry.signature`.
//
// Not a JWT. A JWT brings a library, an algorithm field an attacker can set to
// "none", and a spec's worth of options for a payload that is two values. This
// carries exactly what it needs and is verified in six lines.

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (s) return s;
  // A server that signs sessions with a key it invented at boot logs everyone
  // out on every restart, so this is loud rather than convenient.
  throw new Error("AUTH_SECRET is not set — refusing to sign sessions with a guess");
}

export const authConfigured = () => Boolean(process.env.AUTH_SECRET);

export function mintToken(userId: string, ttlMs = TTL_MS): string {
  const exp = Date.now() + ttlMs;
  const body = `${userId}.${exp}`;
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export type TokenCheck =
  | { ok: true; userId: string }
  | { ok: false; why: "malformed" | "expired" | "bad-signature" };

export function readToken(token: string): TokenCheck {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return { ok: false, why: "malformed" };
  const [userId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!userId || !exp) return { ok: false, why: "malformed" };

  // Signature before expiry: a forged token should not be able to tell the
  // difference between "expired" and "never valid".
  const want = createHmac("sha256", secret()).update(`${userId}.${exp}`).digest("base64url");
  const a = Buffer.from(want);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, why: "bad-signature" };
  if (Date.now() > exp) return { ok: false, why: "expired" };
  return { ok: true, userId };
}

export const newUserId = () => `u_${randomBytes(9).toString("base64url")}`;
