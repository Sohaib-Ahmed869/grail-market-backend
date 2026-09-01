import { TtlCache } from "./ttlcache.js";

// Browsing by set, which is how collectors actually think about cards.
//
// A search box only helps someone who already knows the name. The set list is
// the other half: pick Base Set, see the 102 cards in it, find the one you
// hold. It is also the only way to reach a card whose name you cannot spell
// or cannot read, which for a Japanese print is most of them.
//
// TCGdex serves this and it changes about as often as a new set is printed,
// so both calls are cached for a day. The rule from the pricing path applies
// here too: never a bare Map.

const TCGDEX = process.env.TCGDEX_URL ?? "https://api.tcgdex.net/v2/en";
const DAY = 24 * 3600 * 1000;

const setsCache = new TtlCache<SetSummary[]>(DAY, 8);
const setCache = new TtlCache<SetDetail | null>(DAY, 200);

export type SetSummary = {
  setId: string; name: string; logo: string | null; symbol: string | null;
  total: number; official: number; releasedAt: string | null;
};

export type SetDetail = SetSummary & {
  cards: { cardId: string; name: string; localId: string; imageUrl: string | null }[];
};

/** An image URL from TCGdex needs its size and extension. The bare URL 404s,
 *  which is why every set logo was blank the first time this was tried. */
const img = (base: string | null | undefined, size = "low") =>
  base ? `${base}/${size}.png` : null;

async function json<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${TCGDEX}${path}`, { signal: AbortSignal.timeout(10_000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Every set, newest first — the order a collector wants, because the set
 *  they are holding is far more likely to be recent than to be Base. */
export async function listSets(): Promise<SetSummary[]> {
  const hit = setsCache.get("all");
  if (hit) return hit;

  const raw = await json<any[]>("/sets");
  if (!raw) return [];
  const sets: SetSummary[] = raw.map((s) => ({
    setId: s.id,
    name: s.name,
    logo: img(s.logo, "low"),
    symbol: img(s.symbol, "low"),
    total: s.cardCount?.total ?? 0,
    official: s.cardCount?.official ?? 0,
    releasedAt: s.releaseDate ?? null,
  }));
  sets.reverse();
  setsCache.set("all", sets);
  return sets;
}

export async function getSet(setId: string): Promise<SetDetail | null> {
  const hit = setCache.entry(setId);
  if (hit) return hit.v;

  const s = await json<any>(`/sets/${encodeURIComponent(setId)}`);
  if (!s) {
    setCache.set(setId, null);
    return null;
  }
  const detail: SetDetail = {
    setId: s.id,
    name: s.name,
    logo: img(s.logo, "low"),
    symbol: img(s.symbol, "low"),
    total: s.cardCount?.total ?? 0,
    official: s.cardCount?.official ?? 0,
    releasedAt: s.releaseDate ?? null,
    cards: (s.cards ?? []).map((c: any) => ({
      cardId: c.id,
      name: c.name,
      localId: String(c.localId ?? ""),
      imageUrl: img(c.image, "low"),
    })),
  };
  setCache.set(setId, detail);
  return detail;
}
