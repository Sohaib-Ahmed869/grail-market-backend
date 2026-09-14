import { createHash } from "node:crypto";
import { storePool } from "../cards.store.js";

// Yu-Gi-Oh into the catalogue, from YGOPRODeck.
//
// Free, no key, no contract - the same class of source as the other open
// catalogues, so this costs nothing to run or to re-run.
//
// THE VARIANT AXIS IS RARITY, and it is not cosmetic. YGOPRODeck returns the
// same set code more than once per card with a different rarity each time:
//
//   JUSH-EN040   Starlight Rare
//   JUSH-EN040   Super Rare
//
// One collector code, two products, and in Yu-Gi-Oh the gap between a Super
// Rare and a Starlight Rare of the same card is routinely three orders of
// magnitude. Collapsing them onto the code - which is what storing one row per
// set code would do - is the Shadowless-priced-off-Unlimited failure wearing a
// different game's clothes. So a printing here is (card, set code, rarity).

const API = "https://db.ygoprodeck.com/api/v7/cardinfo.php";

/** A stable id for a printing that has no TCGplayer product id.
 *
 *  `printings.product_id` is a bigint primary key holding TCGplayer's ids,
 *  which are positive. Synthetic ids are NEGATIVE so they can never collide
 *  with a real one, however large TCGplayer's ids grow - and a negative id is
 *  visibly not a TCGplayer id when somebody is reading a row by hand. */
export function syntheticProductId(...parts: string[]): number {
  const h = createHash("sha1").update(parts.join(" ")).digest();
  // 6 bytes keeps it well inside Number.MAX_SAFE_INTEGER, so it survives JSON
  // and the pg driver without turning into a string or losing precision.
  const n = h.readUIntBE(0, 6);
  return -n;
}

export type YgoRow = {
  productId: number;
  cardId: number;
  name: string;
  setCode: string | null;
  setName: string | null;
  rarity: string | null;
  number: string | null;
  numberKey: string | null;
  imageUrl: string | null;
  marketUsd: number | null;
};

/** "JUSH-EN040" stays "JUSH-EN040". Yu-Gi-Oh codes are compound and already
 *  unique within the game, so they survive whole - the same choice made for
 *  One Piece in printings.number_key, and the opposite of Pokemon's "125/197"
 *  which loses its denominator. */
const numberKeyOf = (setCode: string | null) =>
  setCode ? setCode.trim().toUpperCase() : null;

const money = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Flatten one YGOPRODeck card into its printings. */
export function rowsFor(card: Record<string, any>): YgoRow[] {
  const sets: Record<string, any>[] = Array.isArray(card.card_sets) ? card.card_sets : [];
  const image = card.card_images?.[0]?.image_url ?? null;
  const price = money(card.card_prices?.[0]?.tcgplayer_price);
  const name = String(card.name ?? "").trim();
  if (!name || card.id == null) return [];

  // A card with no printings listed is still a card - it goes in with a null
  // set so the catalogue knows it exists, rather than being dropped.
  if (!sets.length) {
    return [{
      productId: syntheticProductId("ygo", String(card.id), "", ""),
      cardId: Number(card.id), name,
      setCode: null, setName: null, rarity: null, number: null, numberKey: null,
      imageUrl: image, marketUsd: price,
    }];
  }

  const seen = new Set<string>();
  const out: YgoRow[] = [];
  for (const s of sets) {
    const setCode = s?.set_code ? String(s.set_code).trim() : null;
    const rarity = s?.set_rarity ? String(s.set_rarity).trim() : null;
    // (code, rarity) is the identity. The same pair twice in one payload is
    // duplication on their side, not a second product.
    const key = `${setCode ?? ""}|${rarity ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      productId: syntheticProductId("ygo", String(card.id), setCode ?? "", rarity ?? ""),
      cardId: Number(card.id),
      name,
      setCode,
      setName: s?.set_name ? String(s.set_name).trim() : null,
      rarity,
      number: setCode,
      numberKey: numberKeyOf(setCode),
      imageUrl: image,
      // Their per-set price is usually "0"; the card-level TCGplayer price is
      // the one with a number in it. Never merged across rarities - it is the
      // same figure on each row, and knowingly approximate until a per-rarity
      // source exists.
      marketUsd: money(s?.set_price) ?? price,
    });
  }
  return out;
}

export type SeedReport = { cards: number; printings: number; written: number; pages: number };

/** Pull and store. `dryRun` fetches and maps but writes nothing. */
export async function seedYugioh(opts: {
  limit?: number; pageSize?: number; dryRun?: boolean;
} = {}): Promise<SeedReport> {
  const report: SeedReport = { cards: 0, printings: 0, written: 0, pages: 0 };
  const pool = storePool();
  const pageSize = Math.min(opts.pageSize ?? 500, 1000);
  const limit = opts.limit ?? 2000;

  for (let offset = 0; offset < limit; offset += pageSize) {
    const num = Math.min(pageSize, limit - offset);
    let body: any;
    try {
      const r = await fetch(`${API}?num=${num}&offset=${offset}`, {
        headers: { "User-Agent": "GrailMarket/1.0 (+https://grailmarket.com)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) break;
      body = await r.json();
    } catch {
      break;
    }
    const cards: Record<string, any>[] = body?.data ?? [];
    if (!cards.length) break;
    report.pages++;
    report.cards += cards.length;

    const rows = cards.flatMap(rowsFor);
    report.printings += rows.length;

    if (!opts.dryRun && pool && rows.length) {
      // printings first, then the catalogue work list.
      await pool.query(
        `insert into printings
           (product_id, game, group_id, set_code, set_name, number, number_key,
            name, variant, rarity, image_url, market_usd)
         select * from unnest(
           $1::bigint[], $2::text[], $3::bigint[], $4::text[], $5::text[],
           $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
           $11::text[], $12::numeric[])
         on conflict (product_id) do update set
           set_name   = excluded.set_name,
           rarity     = excluded.rarity,
           image_url  = coalesce(excluded.image_url, printings.image_url),
           market_usd = coalesce(excluded.market_usd, printings.market_usd),
           fetched_at = now()`,
        [
          rows.map((r) => r.productId),
          rows.map(() => "yugioh"),
          // group_id is TCGplayer's set grouping and we have none; 0 marks
          // "not from TCGplayer" rather than inventing a grouping.
          rows.map(() => 0),
          rows.map((r) => r.setCode),
          rows.map((r) => r.setName),
          rows.map((r) => r.number),
          rows.map((r) => r.numberKey),
          rows.map((r) => r.name),
          // Rarity IS the variant in this game, so it goes in both columns:
          // `variant` for anything reading printings generically, `rarity`
          // for anything that knows what it means.
          rows.map((r) => r.rarity),
          rows.map((r) => r.rarity),
          rows.map((r) => r.imageUrl),
          rows.map((r) => r.marketUsd),
        ],
      );

      // One catalogue entry per CARD, not per printing - catalog_cards is the
      // pricing work list and its id must match what identifyYgo() produces.
      const byCard = new Map<number, YgoRow>();
      for (const r of rows) if (!byCard.has(r.cardId)) byCard.set(r.cardId, r);
      const cs = [...byCard.values()];
      await pool.query(
        `insert into catalog_cards (catalog_id, game, name, set_name, card_number)
         select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
         on conflict (catalog_id) do nothing`,
        [
          cs.map((r) => `ygo-${r.cardId}`),
          cs.map(() => "yugioh"),
          cs.map((r) => r.name),
          cs.map((r) => r.setName),
          cs.map((r) => r.numberKey),
        ],
      );
      report.written += rows.length;
    }

    if (cards.length < num) break;
  }
  return report;
}
