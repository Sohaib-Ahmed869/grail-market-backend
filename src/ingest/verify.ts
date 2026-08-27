import { configuredKeys, recordKeyQuota, readState } from "../scans/pptkeys.js";

// Prove every configured key actually works, and learn its budget.
//
// The pool reports only credits it has OBSERVED, so a key that has never been
// called contributes nothing to the budget — which is honest but means a dead,
// revoked or mistyped key is indistinguishable from a healthy unused one until
// the moment you need it. One cheap call each settles it.
//
// Costs one minimum-size lookup per key. Run it after adding keys, not on a
// schedule.

const PPT_URL = process.env.PPT_API_URL ?? "https://www.pokemonpricetracker.com/api/v2";

export type KeyCheck = {
  id: string;
  ok: boolean;
  status: number | null;
  dailyLimit: number | null;
  remaining: number | null;
  note: string;
};

export async function verifyKeys(): Promise<KeyCheck[]> {
  const keys = configuredKeys();
  if (keys.length === 0) {
    console.warn("[verify] PPT_API_KEY is not set");
    return [];
  }
  console.log(`[verify] checking ${keys.length} key(s), 1 card each`);

  const out: KeyCheck[] = [];
  for (const k of keys) {
    // a cheap, certain-to-exist query — we want the headers, not the card
    const url = `${PPT_URL}/cards?search=${encodeURIComponent("Pikachu")}&limit=1`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${k.key}` },
        signal: AbortSignal.timeout(12000),
      });
      recordKeyQuota(k.id, res);
      const s = readState(k.id);
      const ok = res.ok || res.status === 429; // 429 means the key is real, just spent
      out.push({
        id: k.id,
        ok,
        status: res.status,
        dailyLimit: s.dailyLimit,
        remaining: s.totalRemaining,
        note: res.ok
          ? "live"
          : res.status === 429
            ? "live, out of credits"
            : res.status === 401 || res.status === 403
              ? "REJECTED — revoked or mistyped"
              : `unexpected ${res.status}`,
      });
    } catch (err) {
      out.push({
        id: k.id, ok: false, status: null, dailyLimit: null, remaining: null,
        note: `unreachable :: ${(err as Error).message}`,
      });
    }
  }

  for (const c of out) {
    const budget = c.remaining != null ? `${c.remaining}/${c.dailyLimit ?? "?"}` : "—";
    console.log(`[verify]   ${c.id}  ${c.ok ? "ok " : "BAD"}  ${budget.padStart(9)}  ${c.note}`);
  }
  const bad = out.filter((c) => !c.ok);
  const total = out.reduce((a, c) => a + (c.remaining ?? 0), 0);
  console.log(
    `[verify] ${out.length - bad.length}/${out.length} usable, ${total} credits across the pool`,
  );
  if (bad.length) console.warn(`[verify] ${bad.length} key(s) need attention`);
  return out;
}
