import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Password reset, as a pure decision.
//
// The rules that make a reset link safe are all timing and single-use, and
// none of them need a database to state. Keeping them here means they can be
// tested against a clock we control rather than against `now()`.

/** Thirty minutes. Long enough to walk to a laptop, short enough that a link
 *  sitting in an unattended inbox stops working. */
export const RESET_TTL_MS = 30 * 60 * 1000;

/** How many live links one address may hold. Requesting again invalidates the
 *  older one, so this is a floor on damage rather than a rate limit. */
export const RESET_MAX_LIVE = 1;

/** The token goes in the email; only its digest is stored.
 *
 *  A stolen database therefore contains no usable reset links. This is the
 *  same reason passwords are hashed, and it costs nothing to do here. */
export function newResetToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

/** SHA-256, not scrypt.
 *
 *  Slow hashing defends a low-entropy secret a human chose. This one is 256
 *  random bits — there is nothing to brute force, and a slow hash on the
 *  reset path would only be a way to load the server. */
export const hashToken = (token: string) =>
  createHash("sha256").update(String(token ?? "")).digest("hex");

/** Constant time, and false on anything malformed. */
export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(String(storedHash ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export type ResetRow = {
  token_hash: string;
  expires_at: string | number | Date;
  used_at: string | number | Date | null;
};

export type ResetVerdict =
  | { ok: true }
  | { ok: false; why: "unknown" | "expired" | "used" | "weak" };

/** Every reason a reset can fail, in the order they should be checked.
 *
 *  The caller collapses all of them into one message for the user — telling a
 *  stranger whether a link is "expired" or "already used" is telling them the
 *  link was real. The distinction exists for our logs, not for the response. */
export function resetVerdict(
  row: ResetRow | null | undefined,
  newPassword: string,
  now = Date.now(),
): ResetVerdict {
  if (!row) return { ok: false, why: "unknown" };
  if (row.used_at != null) return { ok: false, why: "used" };
  if (new Date(row.expires_at).getTime() <= now) return { ok: false, why: "expired" };
  if (String(newPassword ?? "").length < 10) return { ok: false, why: "weak" };
  return { ok: true };
}
