import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOTP (RFC 6238) in about eighty lines, with no dependency.
//
// The alternative was a package for what is one HMAC and a modulo. The
// algorithm has not changed since 2011 and is pinned here by its own
// published test vectors, which is a stronger guarantee than a version range.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerant of spaces, lowercase and padding, because people retype these off
 *  a screen and an authenticator app shows them in groups of four. */
export function base32Decode(s: string): Buffer {
  const clean = String(s ?? "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, which is what RFC 4226 assumes and what every app expects. */
export const newSecret = () => base32Encode(randomBytes(20));

export const STEP_SECONDS = 30;
export const DIGITS = 6;

/** HOTP over the time counter. `sha1` is not a security choice here — it is
 *  what every authenticator implements, and the construction is HMAC, which
 *  does not inherit SHA-1's collision problem. */
export function totp(secret: string, timeMs: number, step = STEP_SECONDS, digits = DIGITS): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const mac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** One step either side.
 *
 *  Phone clocks drift and people start typing at second 29. A window of one
 *  costs an attacker nothing meaningful — they still need the code — and
 *  removes the most common reason a correct code is rejected. */
export function verifyTotp(secret: string, code: string, timeMs: number, window = 1): boolean {
  const given = String(code ?? "").replace(/\D/g, "");
  if (given.length !== DIGITS) return false;
  for (let w = -window; w <= window; w++) {
    const want = totp(secret, timeMs + w * STEP_SECONDS * 1000);
    const a = Buffer.from(want), b = Buffer.from(given);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** What the QR code encodes. The issuer appears twice by convention — in the
 *  label so it sorts, and as a parameter so the app can display it. */
export function otpauthUrl(secret: string, account: string, issuer = "GrailCard"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const p = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${p}`;
}

/** Single-use codes for the phone that fell in the sea.
 *
 *  Without these, losing the authenticator means losing the account, and the
 *  support path for that is worse than the risk these carry. */
export function recoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () =>
    randomBytes(5).toString("hex").toUpperCase().replace(/(.{5})/, "$1-"),
  );
}
