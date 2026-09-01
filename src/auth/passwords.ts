import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt) as (
  pw: string | Buffer, salt: string | Buffer, len: number,
) => Promise<Buffer>;

// scrypt, from node's own crypto.
//
// Not SHA-256, and not a dependency. A password hash has to be SLOW — that is
// its entire job. A fast hash means an attacker who takes the table can try
// billions a second; scrypt makes each attempt cost memory as well as time,
// which is what defeats the GPU rigs those attacks actually run on.
const KEYLEN = 64;
const SALT_BYTES = 16;

/** `salt:hash`, both hex. One column, no schema change when the cost moves. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const hash = await scrypt(plain, salt, KEYLEN);
  return `${salt}:${hash.toString("hex")}`;
}

/** Constant-time, and false rather than throwing on anything malformed.
 *
 *  A stored value that is not in the expected shape is a failed login, never
 *  an exception — an endpoint that 500s on a bad row tells an attacker which
 *  rows are interesting. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [salt, want] = String(stored ?? "").split(":");
  if (!salt || !want) return false;
  try {
    const got = await scrypt(plain, salt, KEYLEN);
    const a = Buffer.from(want, "hex");
    return a.length === got.length && timingSafeEqual(a, got);
  } catch {
    return false;
  }
}
