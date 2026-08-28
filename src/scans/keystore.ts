import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { storePool, initStore } from "../cards.store.js";

// Provider API keys, encrypted at rest in the shared store.
//
// They used to live in PPT_API_KEY as a comma-separated list, which stops
// scaling almost immediately: a pool of ten is an unreadable env var, adding or
// revoking one means a redeploy, and every instance needs the same edit applied
// by hand. Keys belong in the database with the rest of the shared state.
//
// WHAT THIS PROTECTS, precisely, because "encrypted" invites more credit than
// it deserves: the ciphertext is useless without PPT_KEY_SECRET, so a database
// dump, a stolen backup, a leaked read-replica or a curious hand on the Neon
// console gets nothing. It does NOT protect against someone who can run code
// on this server or read its environment — they can simply decrypt, exactly as
// the app does. That is the normal and correct boundary for this: it moves the
// secret from many places to one place, and the one place is the thing you
// then guard.
//
// AES-256-GCM: authenticated, so a tampered row fails loudly on decrypt rather
// than silently yielding a corrupt key that looks like an auth failure at the
// provider. Fresh IV per row, never reused.

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard; do not change without re-encrypting
const SALT = "grailcard-provider-keys-v1";

let cachedDerived: Buffer | null = null;

/** Derive the 32-byte data key from the master secret.
 *
 *  scrypt rather than using the secret directly: the secret is a human-managed
 *  string of unknown entropy, and a raw string of the wrong length is not a
 *  valid AES key at all. Derived once and held — scrypt is deliberately slow,
 *  which is the point on a password and pure cost on every request. */
function dataKey(): Buffer | null {
  const secret = process.env.PPT_KEY_SECRET;
  if (!secret) return null;
  cachedDerived ??= scryptSync(secret, SALT, 32);
  return cachedDerived;
}

export function keystoreConfigured(): boolean {
  return Boolean(process.env.PPT_KEY_SECRET);
}

/** Stable public id for a key: the same digest pptkeys.ts uses.
 *
 *  Shared on purpose. Per-key quota and breaker state is already filed under
 *  this id, so a key keeps its budget history when it moves from the env var
 *  into the database rather than silently starting over with a full allowance
 *  it does not have. */
export function keyId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function encrypt(plain: string): { ciphertext: string; iv: string; tag: string } {
  const k = dataKey();
  if (!k) throw new Error("PPT_KEY_SECRET is not set — refusing to store a key in the clear");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, k, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decrypt(row: { ciphertext: string; iv: string; tag: string }): string | null {
  const k = dataKey();
  if (!k) return null;
  try {
    const d = createDecipheriv(ALGO, k, Buffer.from(row.iv, "base64"));
    d.setAuthTag(Buffer.from(row.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(row.ciphertext, "base64")), d.final()]).toString("utf8");
  } catch {
    // Wrong secret, or a tampered row. Either way this key is unusable and
    // must not be returned — a half-decrypted key would present as a provider
    // auth failure and send someone hunting in the wrong place entirely.
    return null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_keys (
  id            TEXT PRIMARY KEY,          -- digest of the key; safe to log
  provider      TEXT NOT NULL DEFAULT 'pokemonpricetracker',
  -- AES-256-GCM. Never a plaintext key, in any column, ever.
  ciphertext    TEXT NOT NULL,
  iv            TEXT NOT NULL,
  tag           TEXT NOT NULL,
  label         TEXT,                      -- human note: which account it came from
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- set to retire a key without losing its history
  disabled_at   TIMESTAMPTZ,
  last_ok_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS provider_keys_live ON provider_keys (provider) WHERE disabled_at IS NULL;
`;

let ready: Promise<boolean> | null = null;
async function ensure(): Promise<boolean> {
  ready ??= (async () => {
    if (!(await initStore())) return false;
    const p = storePool();
    if (!p) return false;
    try {
      await p.query(SCHEMA);
      return true;
    } catch (err) {
      console.warn(`[keystore] unavailable :: ${(err as Error).message}`);
      return false;
    }
  })();
  return ready;
}

export type StoredKeyMeta = {
  id: string;
  label: string | null;
  addedAt: string;
  disabled: boolean;
  lastOkAt: string | null;
  /** false when the row cannot be decrypted with the current secret */
  decryptable: boolean;
};

/** Add a key. Idempotent by id, so re-running an import is safe. */
export async function addKey(key: string, label?: string | null): Promise<{ id: string; added: boolean }> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("empty key");
  if (!(await ensure())) throw new Error("keystore unavailable");
  const id = keyId(trimmed);
  const enc = encrypt(trimmed);
  const p = storePool()!;
  const res = await p.query(
    `INSERT INTO provider_keys (id, ciphertext, iv, tag, label)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO NOTHING`,
    [id, enc.ciphertext, enc.iv, enc.tag, label ?? null],
  );
  return { id, added: (res.rowCount ?? 0) > 0 };
}

export async function setKeyDisabled(id: string, disabled: boolean): Promise<boolean> {
  if (!(await ensure())) return false;
  const p = storePool()!;
  const res = await p.query(
    `UPDATE provider_keys SET disabled_at = ${disabled ? "now()" : "NULL"} WHERE id = $1`,
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markKeyOk(id: string): Promise<void> {
  if (!(await ensure())) return;
  try {
    await storePool()!.query(`UPDATE provider_keys SET last_ok_at = now() WHERE id = $1`, [id]);
  } catch {
    /* bookkeeping must never break a lookup */
  }
}

/** Metadata only — never returns key material. For the CLI and any endpoint. */
export async function listKeys(): Promise<StoredKeyMeta[]> {
  if (!(await ensure())) return [];
  const { rows } = await storePool()!.query(
    `SELECT * FROM provider_keys ORDER BY added_at`,
  );
  return rows.map((r: any) => ({
    id: r.id,
    label: r.label ?? null,
    addedAt: new Date(r.added_at).toISOString(),
    disabled: Boolean(r.disabled_at),
    lastOkAt: r.last_ok_at ? new Date(r.last_ok_at).toISOString() : null,
    decryptable: decrypt(r) != null,
  }));
}

/** Every usable key, decrypted. Call sparingly — pptkeys.ts caches the result. */
export async function loadKeys(): Promise<{ id: string; key: string }[]> {
  if (!keystoreConfigured() || !(await ensure())) return [];
  try {
    const { rows } = await storePool()!.query(
      `SELECT * FROM provider_keys WHERE disabled_at IS NULL ORDER BY added_at`,
    );
    const out: { id: string; key: string }[] = [];
    for (const r of rows) {
      const key = decrypt(r);
      if (!key) {
        console.warn(`[keystore] key ${r.id} will not decrypt — wrong PPT_KEY_SECRET, or the row was altered`);
        continue;
      }
      out.push({ id: r.id, key });
    }
    return out;
  } catch (err) {
    console.warn(`[keystore] load failed :: ${(err as Error).message}`);
    return [];
  }
}
