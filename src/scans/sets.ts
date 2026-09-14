import { TtlCache } from "./ttlcache.js";
import { seedCatalogPrice, storePool } from "../cards.store.js";

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

export type SetCard = {
  cardId: string; name: string; localId: string; imageUrl: string | null;
  /** The ungraded price, in US dollars, or null where nobody has one.
   *
   *  Three catalogues hand it to us in their set listing (Magic, Lorcana,
   *  One Piece). For the rest it comes from our own store, where a card has
   *  been priced before. Null is the honest answer everywhere else — a set
   *  page that printed 0 would be claiming every unpriced card is worthless. */
  rawUsd: number | null;
  rarity: string | null;
};

export type SetDetail = SetSummary & { cards: SetCard[] };

/** Fill in raw prices from what we already hold.
 *
 *  A set page shows every card at once, and most sources say nothing about
 *  price in their set listing — TCGdex, which is Pokemon, says nothing at all.
 *  But every card that has ever been scanned or listed here has a row in
 *  catalog_cards, and many of those carry raw_usd. One query for the whole
 *  set, applied only where the source left a gap, so a source's own figure is
 *  never overwritten by an older one of ours. */
export async function overlayStorePrices(cards: SetCard[]): Promise<SetCard[]> {
  const pool = storePool();
  if (!pool || !cards.length) return cards;
  const missing = cards.filter((c) => c.rawUsd == null).map((c) => c.cardId);
  if (!missing.length) return cards;
  try {
    const r = await pool.query(
      "select catalog_id, raw_usd from catalog_cards where catalog_id = any($1) and raw_usd is not null",
      [missing],
    );
    const held = new Map<string, number>(r.rows.map((x: any) => [String(x.catalog_id), Number(x.raw_usd)]));
    return cards.map((c) => c.rawUsd == null && held.has(c.cardId) ? { ...c, rawUsd: held.get(c.cardId)! } : c);
  } catch {
    return cards;
  }
}

/** TCGdex publishes a price for every Pokemon card — on the CARD endpoint.
 *
 *  Its set listing carries id, image, number and name and nothing else, and
 *  that is what this file had read, so every Pokemon set page showed a dash
 *  under every card and "1 priced" of 120. Each card's own record carries
 *  `pricing.tcgplayer` in US dollars by printing — normal, holofoil, reverse
 *  holofoil — updated daily, and `rarity`.
 *
 *  Fetched eight at a time for the whole set, held for a day, and WRITTEN
 *  BACK into catalog_cards, because the set page is not the only screen with
 *  this hole: the collection, the card page and the market all read raw_usd
 *  from the store, and a price that lives only in this cache fixes one screen
 *  and leaves the same dash on the other three. */
const priceCache = new TtlCache<{ rawUsd: number | null; rarity: string | null }>(DAY, 20_000);

const marketOf = (t: any): number | null => {
  // The primary printing's market price. A holofoil-only card has no
  // "normal"; the first printing that carries a figure is its price.
  for (const k of ["normal", "holofoil", "reverse-holofoil"]) {
    const n = Number(t?.[k]?.marketPrice);
    if (Number.isFinite(n) && n > 0) return n;
  }
  for (const v of Object.values(t ?? {})) {
    const n = Number((v as any)?.marketPrice);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
};

async function pokemonPricing(ids: string[]): Promise<Map<string, { rawUsd: number | null; rarity: string | null }>> {
  const out = new Map<string, { rawUsd: number | null; rarity: string | null }>();
  const todo: string[] = [];
  for (const id of ids) {
    const hit = priceCache.get(id);
    if (hit) out.set(id, hit); else todo.push(id);
  }
  const CONCURRENCY = 8;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(async (id) => {
      try {
        const r = await fetch(`${TCGDEX}/cards/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8_000) });
        if (!r.ok) return;
        const c = (await r.json()) as any;
        const v = { rawUsd: marketOf(c?.pricing?.tcgplayer), rarity: c?.rarity ?? null };
        priceCache.set(id, v);
        out.set(id, v);
      } catch {
        // one card's price failing is one dash, not a failed set
      }
    }));
  }
  return out;
}

/** TCGdex asset URLs come back without an extension, and the two kinds want
 *  different suffixes:
 *
 *    set logo    .../base1/logo      -> logo.png
 *    card art    .../base1/4         -> 4/low.png
 *
 *  Appending "/low.png" to a logo 404s, which is exactly what turned every
 *  set tile into a blank white box. Verified against the CDN, not guessed. */
const logoUrl = (base: string | null | undefined) => (base ? `${base}.png` : null);
const cardUrl = (base: string | null | undefined, size = "low") =>
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
    logo: logoUrl(s.logo),
    symbol: logoUrl(s.symbol),
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
    logo: logoUrl(s.logo),
    symbol: logoUrl(s.symbol),
    total: s.cardCount?.total ?? 0,
    official: s.cardCount?.official ?? 0,
    releasedAt: s.releaseDate ?? null,
    cards: [] as SetCard[],
  };
  const raw: any[] = s.cards ?? [];
  const priced = await pokemonPricing(raw.map((c) => String(c.id)));
  const cards: SetCard[] = raw.map((c: any) => {
    const p = priced.get(String(c.id));
    return {
      cardId: c.id,
      name: c.name,
      localId: String(c.localId ?? ""),
      imageUrl: cardUrl(c.image, "low"),
      rawUsd: p?.rawUsd ?? null,
      rarity: p?.rarity ?? null,
    };
  });
  detail.cards = await overlayStorePrices(cards);
  // Written back so the other three screens that read raw_usd get it too.
  // Not awaited: the page should not wait on a hundred inserts, and a write
  // that fails costs nothing the page needed.
  for (const c of detail.cards) {
    if (c.rawUsd != null) {
      void seedCatalogPrice({
        catalogId: c.cardId, game: "pokemon", name: c.name,
        setName: detail.name, cardNumber: c.localId, rawUsd: c.rawUsd,
      });
    }
  }
  setCache.set(setId, detail);
  return detail;
}
