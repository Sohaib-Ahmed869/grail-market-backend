import { TtlCache } from "./ttlcache.js";
import { CATEGORY, groupsFor, setContents } from "../printings/tcgcsv.js";

// Sealed product — booster boxes, Elite Trainer Boxes, tins, collections.
//
// Collectors browse a game by its PRODUCTS as much as by its cards: "the 30th
// Celebration Pokemon Center Elite Trainer Box" is a thing people buy, hold
// and price, and a catalogue that only knows singles has nothing to show them.
//
// tcgcsv already hands us every product in a set whenever `printings` reads
// one, singles and sealed together. The sealed ones are the rows with neither
// a collector number nor a rarity — a card always carries both, a box never
// does. No new provider and no new cost: the same two cached calls per set.
//
// The price is TCGplayer's market price for that exact product id. Never a
// name search: "Elite Trainer Box" and "Pokemon Center Elite Trainer Box" of
// the same set are a US$60 and a US$670 product, one word apart.

export type SealedProduct = {
  productId: number;
  name: string;
  imageUrl: string | null;
  url: string | null;
  /** TCGplayer market price, US$. Null when nobody has one — a pre-order or
   *  a product too scarce to have sold recently. Never a zero. */
  marketUsd: number | null;
  lowUsd: number | null;
};

export type SealedGroup = {
  setId: string;
  setName: string;
  releasedAt: string | null;
  products: SealedProduct[];
};

/** Which tcgcsv category holds a game's sealed product. The language
 *  editions TCGdex and Scryfall serve carry no sealed product at all. */
export const sealedCategoryOf = (game: string): number | null => CATEGORY[game] ?? null;

/** Code cards are sealed in the sense that they have no number, and are not
 *  a product anybody collects — they are a redemption code on cardboard. */
const NOT_A_PRODUCT = /\bcode card\b|\bonline code\b/i;

export function sealedFrom(
  products: { productId: number; name: string; imageUrl: string | null; url: string | null; number: string | null; rarity: string | null }[],
  prices: { productId: number; subTypeName: string | null; marketPrice: number | null; lowPrice: number | null }[],
): SealedProduct[] {
  const byProduct = new Map<number, typeof prices>();
  for (const p of prices) byProduct.set(p.productId, [...(byProduct.get(p.productId) ?? []), p]);
  return products
    .filter((p) => !p.number && !p.rarity && !NOT_A_PRODUCT.test(p.name))
    .map((p) => {
      const rows = byProduct.get(p.productId) ?? [];
      // A sealed product is priced as one thing; if TCGplayer splits it by
      // finish anyway, the Normal row is the product and anything else is a
      // variant we cannot name here.
      const row = rows.find((r) => (r.subTypeName ?? "").toLowerCase() === "normal") ?? (rows.length === 1 ? rows[0] : undefined);
      return {
        productId: p.productId,
        name: p.name,
        imageUrl: p.imageUrl,
        url: p.url,
        marketUsd: row?.marketPrice ?? null,
        lowUsd: row?.lowPrice ?? null,
      };
    });
}

const PAGE_GROUPS = 4;
/** Sets looked at per page before giving up on finding sealed product —
 *  promo lines and single-card sets carry none, and a run of them must not
 *  make a page come back empty when the next set has twenty boxes. */
const MAX_SCAN = 16;

const pageCache = new TtlCache<{ groups: SealedGroup[]; next: number | null }>(6 * 3600_000, 400);

/** One page of a game's sealed product, newest set first.
 *
 *  `cursor` is an index into the game's set list. The answer carries the
 *  cursor for the next page, or null at the end. */
export async function sealedPage(game: string, cursor = 0): Promise<{ groups: SealedGroup[]; next: number | null; supported: boolean }> {
  if (sealedCategoryOf(game) == null) return { groups: [], next: null, supported: false };
  const key = `${game}:${cursor}`;
  const hit = pageCache.get(key);
  if (hit) return { ...hit, supported: true };

  const groups = [...(await groupsFor(game).catch(() => []))]
    // Newest first by release date where tcgcsv has one, falling back to the
    // group id, which climbs with time.
    .sort((a, b) => (b.publishedOn ?? "").localeCompare(a.publishedOn ?? "") || b.groupId - a.groupId);

  const out: SealedGroup[] = [];
  let i = cursor;
  let scanned = 0;
  let failed = false;
  while (i < groups.length && out.length < PAGE_GROUPS && scanned < MAX_SCAN) {
    const g = groups[i]!;
    i += 1;
    scanned += 1;
    const contents = await setContents(game, g.groupId).catch(() => null);
    if (!contents) { failed = true; continue; }
    const products = sealedFrom(contents.products, contents.prices);
    if (products.length) {
      out.push({ setId: `tcg:${game}:${g.groupId}`, setName: g.name, releasedAt: g.publishedOn ?? null, products });
    }
  }
  const page = { groups: out, next: i < groups.length ? i : null };
  // An upstream failure mid-page is not cached, or a bad minute at tcgcsv
  // would hide a set's boxes for six hours.
  if (!failed && groups.length) pageCache.set(key, page);
  return { ...page, supported: true };
}
