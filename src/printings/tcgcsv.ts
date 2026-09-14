import { TtlCache } from "../scans/ttlcache.js";

/** TCGplayer's catalogue, mirrored, free and keyed on the PRINTING.
 *
 *  The defect this exists to close: our catalogue gives one id to every
 *  printing of a card. `optcg-OP13-118` is the base Secret Rare, the
 *  Parallel, the Wanted Poster, the Super Alternate Art and the Red Super
 *  Alternate Art — five different objects between about US$13 and several
 *  thousand — and because they share an id, the expensive one has no address.
 *  It cannot be pointed at, priced, or listed. The app answered A$197 for a
 *  card the market puts in four figures, by taking the median asking price of
 *  whatever eBay returned for the words "Monkey D Luffy 118".
 *
 *  TCGplayer models exactly what we do not: 657400, 657401, 657402, 657403
 *  and 657404 are five products with five prices. Their own API stopped
 *  granting new keys years ago, so it is closed to us. tcgcsv.com mirrors the
 *  same public endpoints daily, free, with no key and no approval.
 *
 *  Two properties make this a LOOKUP rather than a search, which is the whole
 *  point:
 *
 *    - `extendedData.Number` is exactly the collector code we already store
 *      as `localId` ("OP13-118"), so the join is an equality test. No name
 *      similarity, no set-word overlap, none of the machinery that has been
 *      quietly matching the wrong card.
 *    - every printing carries its own image, which is what a person needs in
 *      order to say which one they are holding.
 *
 *  Treated as a source to CACHE, never to call live: it is a community mirror
 *  rather than a contract, so an outage must cost us freshness and never a
 *  page. Nothing here is on a schedule — a set is fetched the first time
 *  somebody asks about a card in it, which is the same request-driven rule
 *  the rest of the background work follows.
 */

const BASE = "https://tcgcsv.com/tcgplayer";

/** Our game ids to theirs. Japanese Pokemon is a separate category there and
 *  is deliberately not mapped: it is a different market with different prices,
 *  and folding it in is the mistake `printing.ts` already guards against. */
export const CATEGORY: Record<string, number> = {
  mtg: 1,
  yugioh: 2,
  pokemon: 3,
  digimon: 63,
  onepiece: 68,
  lorcana: 71,
  gatcg: 74,
  sorcery: 77,
  swu: 79,
};

export type TcgGroup = { groupId: number; name: string; abbreviation: string | null };

export type TcgProduct = {
  productId: number;
  name: string;
  imageUrl: string | null;
  url: string | null;
  groupId: number;
  number: string | null;
  rarity: string | null;
};

export type TcgPrice = {
  productId: number;
  subTypeName: string | null;
  marketPrice: number | null;
  lowPrice: number | null;
  highPrice: number | null;
};

const groupCache = new TtlCache<TcgGroup[]>(24 * 3600_000, 32);
const setCache = new TtlCache<{ products: TcgProduct[]; prices: TcgPrice[] }>(6 * 3600_000, 200);

/** The mirror asks callers to identify themselves and answers 401 to anything
 *  that does not — which is the correct manners for a free service somebody
 *  runs at their own cost, and worth honouring rather than working around. */
const UA = "GrailMarket/1.0 (+https://grailcard.com.au)";

async function json<T>(url: string): Promise<T | null> {
  try {
    // A mirror that is slow is a mirror that is down as far as a request
    // handler is concerned.
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      console.warn(`[printings] tcgcsv ${r.status} for ${url}`);
      return null;
    }
    return (await r.json()) as T;
  } catch (e) {
    console.warn(`[printings] tcgcsv unreachable: ${String(e).slice(0, 120)}`);
    return null;
  }
}

const ext = (p: any, field: string): string | null => {
  const hit = (p?.extendedData ?? []).find((e: any) => e?.name === field);
  const v = hit?.value;
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

export async function groupsFor(game: string): Promise<TcgGroup[]> {
  const cat = CATEGORY[game];
  if (!cat) return [];
  const hit = groupCache.get(game);
  if (hit) return hit;
  const r = await json<{ results?: any[] }>(`${BASE}/${cat}/groups`);
  const out: TcgGroup[] = (r?.results ?? []).map((g) => ({
    groupId: Number(g.groupId),
    name: String(g.name ?? ""),
    abbreviation: g.abbreviation ? String(g.abbreviation) : null,
  }));
  if (out.length) groupCache.set(game, out);
  return out;
}

/** One set's products and prices, in the two calls they come in. */
export async function setContents(
  game: string,
  groupId: number,
): Promise<{ products: TcgProduct[]; prices: TcgPrice[] }> {
  const cat = CATEGORY[game];
  if (!cat) return { products: [], prices: [] };
  const key = `${game}:${groupId}`;
  const hit = setCache.get(key);
  if (hit) return hit;

  const [p, q] = await Promise.all([
    json<{ results?: any[] }>(`${BASE}/${cat}/${groupId}/products`),
    json<{ results?: any[] }>(`${BASE}/${cat}/${groupId}/prices`),
  ]);

  const products: TcgProduct[] = (p?.results ?? []).map((x) => ({
    productId: Number(x.productId),
    name: String(x.name ?? ""),
    imageUrl: x.imageUrl ? String(x.imageUrl) : null,
    url: x.url ? String(x.url) : null,
    groupId: Number(x.groupId),
    number: ext(x, "Number"),
    rarity: ext(x, "Rarity"),
  }));

  const prices: TcgPrice[] = (q?.results ?? []).map((x) => ({
    productId: Number(x.productId),
    subTypeName: x.subTypeName ? String(x.subTypeName) : null,
    // Their "no market" sentinel is a low and high of 99999 with a null
    // market. That is not a price and must never be treated as one: it means
    // nobody has one listed, which for a chase card is the true answer and
    // the one our own rules say to give.
    marketPrice: num(x.marketPrice),
    lowPrice: sane(num(x.lowPrice)),
    highPrice: sane(num(x.highPrice)),
  }));

  const out = { products, prices };
  if (products.length) setCache.set(key, out);
  return out;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 99999 is their "none listed" marker, not a ten-thousand-dollar ask. */
const sane = (n: number | null): number | null => (n != null && n >= 99_999 ? null : n);

/** The variant this product is, read off the tail of its name.
 *
 *  Their naming is consistent: the base card is "Monkey.D.Luffy (118)" and
 *  every other printing appends a parenthetical — "(Parallel)", "(Red Super
 *  Alternate Art)". The FIRST parenthetical is the collector number and is
 *  not a variant, so it is dropped. */
export function variantOf(name: string): string | null {
  const parts = [...name.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]!.trim());
  const tail = parts.filter((p) => !/^\d+[a-z]?$/i.test(p));
  return tail.length ? tail.join(" · ") : null;
}
