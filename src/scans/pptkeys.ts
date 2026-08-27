import { createHash } from "node:crypto";
import { db } from "../db.js";

// A pool of provider keys, each with its own budget and its own breaker.
//
// This exists because quota state was global. One `ppt:quota` snapshot and one
// `ppt:quota_resets_at` breaker, both overwritten by whichever call answered
// last. With a single key that is correct and simple. With more than one it is
// actively wrong: a 429 on key A trips the breaker for every key, one key's
// remaining credits get reported as the pool's, and the budget endpoint —
// which people read to decide whether the product is working — describes a key
// picked at random.
//
// So state is per key, addressed by a short digest of the key itself rather
// than its position in the list. Reordering PPT_API_KEY, or dropping a dead
// key from the middle, then does not silently reassign one key's quota to
// another.
//
// The key material is never logged or stored — only the digest. Nothing here
// should ever end up in a log line, an error message, or the quota endpoint.

export type KeyState = {
  /** stable short id derived from the key; safe to log */
  id: string;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  purchasedRemaining: number | null;
  totalRemaining: number | null;
  resetsAt: string | null;
  observedAt: string | null;
  /** epoch ms until which this key is known to be out of credits */
  lockedUntil: number;
};

const readKv = db.prepare("SELECT value FROM kv WHERE key = ?");
const writeKv = db.prepare(
  "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** The configured keys, in order. Comma or whitespace separated.
 *
 *  A single key is the overwhelmingly common case and stays exactly as it was
 *  — one entry in the pool, same behaviour, no rotation to reason about. */
export function configuredKeys(): { id: string; key: string }[] {
  const raw = process.env.PPT_API_KEY ?? "";
  const seen = new Set<string>();
  const out: { id: string; key: string }[] = [];
  for (const key of raw.split(/[,\s]+/).map((k) => k.trim()).filter(Boolean)) {
    const id = digest(key);
    // The same key listed twice is one key. Left in, it would be counted twice
    // in the pool's remaining credits — so the budget would claim headroom
    // that does not exist, and the job would plan a batch it cannot pay for.
    // Easy to do by accident when keys are pasted in from several places.
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, key });
  }
  return out;
}

function stateKey(id: string): string {
  return `ppt:key:${id}`;
}

export function readState(id: string): KeyState {
  const row = readKv.get(stateKey(id)) as { value: string } | undefined;
  let s: Record<string, any> = {};
  try {
    s = row ? JSON.parse(row.value) : {};
  } catch {
    s = {};
  }
  return {
    id,
    dailyLimit: s.dailyLimit ?? null,
    dailyRemaining: s.dailyRemaining ?? null,
    purchasedRemaining: s.purchasedRemaining ?? null,
    totalRemaining:
      typeof s.totalRemaining === "number"
        ? s.totalRemaining
        : typeof s.dailyRemaining === "number"
          ? s.dailyRemaining
          : null,
    resetsAt: s.resetsAt ?? null,
    observedAt: s.observedAt ?? null,
    lockedUntil: Number.isFinite(s.lockedUntil) ? Number(s.lockedUntil) : 0,
  };
}

function writeState(id: string, patch: Partial<KeyState>): void {
  const merged = { ...readState(id), ...patch };
  writeKv.run(stateKey(id), JSON.stringify(merged));
}

/** Record what a response said about the key that made it. */
export function recordKeyQuota(id: string, res: Response): void {
  const n = (h: string): number | null => {
    const v = res.headers.get(h);
    if (v == null) return null;
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const dailyLimit = n("x-ratelimit-daily-limit");
  const dailyRemaining = n("x-ratelimit-daily-remaining");
  if (dailyLimit == null && dailyRemaining == null) return; // not a PPT-shaped response
  const resetUnix = n("x-ratelimit-daily-reset");
  writeState(id, {
    dailyLimit,
    dailyRemaining,
    purchasedRemaining: n("x-ratelimit-purchased-remaining"),
    totalRemaining: n("x-ratelimit-total-remaining"),
    resetsAt: resetUnix != null ? new Date(resetUnix * 1000).toISOString() : null,
    observedAt: new Date().toISOString(),
  });
}

/** This key is out of credits until `untilMs`. Only this key. */
export function lockKey(id: string, untilMs: number): void {
  writeState(id, { lockedUntil: untilMs });
}

export function lockedFor(id: string): number {
  return Math.max(0, readState(id).lockedUntil - Date.now());
}

/** Pick a key to spend, or null when every key is spent.
 *
 *  Most-remaining-first rather than round-robin. Round-robin spreads a batch
 *  evenly and lands every key near empty at the same moment, which is the
 *  worst possible arrangement: nothing is left anywhere and everything has to
 *  wait for the same reset. Draining the fullest key first keeps the others
 *  intact as genuine headroom.
 *
 *  A key we have never called has no observed budget, so it sorts first — the
 *  only way to learn what it has is to use it once.
 */
export function pickKey(costCredits: number): { id: string; key: string } | null {
  const keys = configuredKeys();
  if (keys.length === 0) return null;

  const now = Date.now();
  const usable = keys
    .map((k) => ({ ...k, state: readState(k.id) }))
    .filter((k) => k.state.lockedUntil <= now)
    .filter((k) => k.state.totalRemaining == null || k.state.totalRemaining >= costCredits)
    .sort((a, b) => {
      const ar = a.state.totalRemaining;
      const br = b.state.totalRemaining;
      if (ar == null && br == null) return 0;
      if (ar == null) return -1; // unknown budget: try it and find out
      if (br == null) return 1;
      return br - ar;
    });

  const chosen = usable[0];
  return chosen ? { id: chosen.id, key: chosen.key } : null;
}

/** Pool totals, for the budget endpoint. */
export function poolStatus(): {
  keys: KeyState[];
  configured: boolean;
  totalRemaining: number | null;
  dailyLimit: number | null;
  /** true when every configured key is locked out */
  allLockedOut: boolean;
  /** soonest reset across the pool */
  resetsAt: string | null;
} {
  const keys = configuredKeys().map((k) => readState(k.id));
  if (keys.length === 0) {
    return {
      keys: [], configured: false, totalRemaining: null,
      dailyLimit: null, allLockedOut: false, resetsAt: null,
    };
  }
  const now = Date.now();
  const known = keys.filter((k) => k.totalRemaining != null);
  const limits = keys.filter((k) => k.dailyLimit != null);
  const resets = keys.map((k) => k.resetsAt).filter((r): r is string => Boolean(r)).sort();
  return {
    keys,
    configured: true,
    // Sum only what we have actually observed. A key we have never called
    // contributes nothing rather than an assumed allowance — reporting credits
    // we have not seen is how a budget display starts lying.
    totalRemaining: known.length ? known.reduce((a, k) => a + (k.totalRemaining ?? 0), 0) : null,
    dailyLimit: limits.length ? limits.reduce((a, k) => a + (k.dailyLimit ?? 0), 0) : null,
    allLockedOut: keys.every((k) => k.lockedUntil > now),
    resetsAt: resets[0] ?? null,
  };
}
