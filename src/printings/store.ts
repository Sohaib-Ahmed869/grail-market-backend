import { storePool } from "../cards.store.js";
import { groupsFor, setContents, variantOf, CATEGORY, type TcgProduct } from "./tcgcsv.js";
import { asksByProduct } from "./asks.js";

/** Printings: one row per physically distinct card, which our catalogue does
 *  not have and cannot get to.
 *
 *  `catalog_cards` is keyed on `catalog_id` alone, so five printings of
 *  OP13-118 are one row with one price. This table is keyed on TCGplayer's
 *  product id, which IS the printing, and is joined back to us on the
 *  collector number we already store. Nothing here overwrites the catalogue;
 *  it sits beside it and answers the question the catalogue cannot: which
 *  versions of this card exist, and what is each one worth.
 *
 *  Populated lazily, one set at a time, the first time somebody asks about a
 *  card in it — the same request-driven rule as the rest of the background
 *  work here, and the reason there is no cron in this repo. */
export const PRINTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS printings (
  product_id   bigint PRIMARY KEY,
  game         text NOT NULL,
  group_id     bigint NOT NULL,
  set_code     text,
  set_name     text,
  -- the collector code as TCGplayer writes it: "OP13-118", "125/197".
  number       text,
  -- the same number reduced to what BOTH catalogues agree on, because they
  -- do not write it the same way. One Piece is compound on both sides and
  -- survives whole; Pokemon is "125/197" here and "125" for us, so the
  -- denominator goes. Zero padding goes too: ours says "001".
  number_key   text,
  name         text NOT NULL,
  -- the parenthetical that makes it a different object: "Red Super
  -- Alternate Art", "Parallel". Null on the base printing.
  variant      text,
  rarity       text,
  image_url    text,
  url          text,
  sub_type     text,
  -- sale-derived, from TCGplayer. Absent on the scarcest cards, which are
  -- exactly the ones worth getting right.
  market_usd   numeric,
  -- the lowest Near Mint copy someone is LISTING, from JustTCG, joined on
  -- the TCGplayer product id. An ask, never merged into the market price.
  listed_usd   numeric,
  listed_cond  text,
  low_usd      numeric,
  high_usd     numeric,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);
`;

/** Schema moves in place, the way every other store here does it — there is
 *  no migration tool in this repo. Stated separately from CREATE TABLE
 *  because a table that already exists never re-runs its column list. */
const PRINTINGS_MIGRATE = `
ALTER TABLE printings ADD COLUMN IF NOT EXISTS number_key text;
ALTER TABLE printings ADD COLUMN IF NOT EXISTS listed_usd numeric;
ALTER TABLE printings ADD COLUMN IF NOT EXISTS listed_cond text;
CREATE INDEX IF NOT EXISTS printings_lookup ON printings (game, group_id, number_key);
CREATE INDEX IF NOT EXISTS printings_group  ON printings (game, group_id);
`;

export async function initPrintings(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(PRINTINGS_SCHEMA);
  await pool.query(PRINTINGS_MIGRATE);
}

export type Printing = {
  productId: number;
  name: string;
  variant: string | null;
  rarity: string | null;
  imageUrl: string | null;
  url: string | null;
  subType: string | null;
  /** From completed sales. Null on a card with none — say so, never guess. */
  marketUsd: number | null;
  lowUsd: number | null;
  highUsd: number | null;
  /** The cheapest Near Mint copy currently listed. An ASK. */
  listedUsd: number | null;
  listedCondition: string | null;
};

/** Which of their sets is ours.
 *
 *  Matched on the abbreviation first, because "OP13" is unambiguous and a set
 *  name is not: "Carrying On His Will" is written six ways across catalogues.
 *  The collector code carries the abbreviation in front of it for One Piece
 *  and Digimon, which is most of the sets where printings collide. */
async function groupFor(game: string, number: string | null, setName: string | null) {
  const groups = await groupsFor(game);
  if (!groups.length) return null;

  const code = number?.toUpperCase().match(/^([A-Z]{1,4}\d{0,3})[-\s]/)?.[1] ?? null;
  if (code) {
    const byAbbr = groups.find((g) => (g.abbreviation ?? "").toUpperCase() === code);
    if (byAbbr) return byAbbr;
  }
  if (setName) {
    const want = norm(setName);
    // Their Pokemon set names carry the release code in front — "ME05: Pitch
    // Black" against our "Pitch Black" — so the part after the colon is
    // compared as well as the whole thing.
    const tail = (g: { name: string }) => norm(g.name.split(":").slice(1).join(":") || g.name);
    return (
      groups.find((g) => norm(g.name) === want) ??
      groups.find((g) => tail(g) === want) ??
      null
    );
  }
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The part of a collector number the two catalogues actually agree on.
 *
 *  Ours stores "001" and "OP13-118"; theirs stores "125/197" and "OP13-118".
 *  A compound code is an identity and is kept whole. Anything else is a
 *  number within a set, so the denominator and the zero padding — neither of
 *  which either side writes consistently — come off. Scoped to one set by the
 *  caller, which is what makes a bare "1" safe to compare at all. */
export function numberKey(n: string | null | undefined): string | null {
  const s = (n ?? "").trim().toUpperCase();
  if (!s) return null;
  if (/^[A-Z]{1,4}\d{0,3}-\d{1,4}[A-Z]?$/.test(s)) return s;   // OP13-118
  const head = s.split("/")[0]!.trim();                          // 125/197 -> 125
  const m = head.match(/^([A-Z]*)0*(\d+)([A-Z]?)$/);            // 001 -> 1, SWSH005 -> SWSH5
  return m ? `${m[1]}${m[2]}${m[3]}` : head;
}

/** Store a whole set's printings. One write for the set, not one per card. */
async function ingest(game: string, groupId: number, setName: string): Promise<number> {
  const pool = storePool();
  if (!pool) return 0;
  const { products, prices } = await setContents(game, groupId);
  if (!products.length) return 0;

  // Their prices come as one row per product PER SUB-TYPE (Normal, Foil).
  // The dearest sub-type is the one a chase card trades as, and taking the
  // first would make a foil-only card look like it has no price at all.
  const best = new Map<number, (typeof prices)[number]>();
  for (const p of prices) {
    const had = best.get(p.productId);
    if (!had || (p.marketPrice ?? 0) > (had.marketPrice ?? 0)) best.set(p.productId, p);
  }

  const code = (await groupsFor(game)).find((g) => g.groupId === groupId)?.abbreviation ?? null;

  const rows = products.map((x: TcgProduct) => {
    const pr = best.get(x.productId);
    return [
      x.productId, game, groupId, code, setName, x.number, numberKey(x.number),
      x.name, variantOf(x.name), x.rarity, x.imageUrl, x.url,
      pr?.subTypeName ?? null, pr?.marketPrice ?? null, pr?.lowPrice ?? null, pr?.highPrice ?? null,
      null, null,   // asks are fetched per card viewed — see printingsFor
    ];
  });

  const values = rows
    .map((_, i) => `(${Array.from({ length: 18 }, (_, k) => `$${i * 18 + k + 1}`).join(",")})`)
    .join(",");

  await pool.query(
    `insert into printings
       (product_id, game, group_id, set_code, set_name, number, number_key, name,
        variant, rarity, image_url, url, sub_type, market_usd, low_usd, high_usd,
        listed_usd, listed_cond)
     values ${values}
     on conflict (product_id) do update set
       -- Everything derived, not just the prices. A row written before a
       -- column existed keeps its null forever if the update does not name
       -- it, which is how the One Piece rows survived this migration with no
       -- join key and quietly returned nothing.
       number     = excluded.number,
       number_key = excluded.number_key,
       name       = excluded.name,
       variant    = excluded.variant,
       set_code   = excluded.set_code,
       set_name   = excluded.set_name,
       market_usd = excluded.market_usd,
       -- coalesce, because a set ingest does not fetch asks and must not
       -- erase the one this card already has.
       listed_usd = coalesce(excluded.listed_usd, printings.listed_usd),
       listed_cond = coalesce(excluded.listed_cond, printings.listed_cond),
       low_usd    = excluded.low_usd,
       high_usd   = excluded.high_usd,
       image_url  = excluded.image_url,
       url        = excluded.url,
       rarity     = excluded.rarity,
       sub_type   = excluded.sub_type,
       fetched_at = now()`,
    rows.flat(),
  );
  return rows.length;
}

/** Is this set's data old enough to be worth re-reading? */
const STALE_MS = 24 * 3600_000;
const inFlight = new Map<string, Promise<unknown>>();

/** Every printing of one collector number.
 *
 *  The answer to "which versions of this card exist and what is each worth",
 *  which is the question the whole variant defect comes down to. Reads what
 *  is stored, and fetches the set behind it when we have nothing or what we
 *  have has gone stale — deduped, so twenty people opening the same card do
 *  not start twenty downloads of the same set. */
export async function printingsFor(a: {
  game: string | null;
  number: string | null;
  setName?: string | null;
}): Promise<Printing[]> {
  const pool = storePool();
  const { game, number } = a;
  if (!pool || !game || !number || !CATEGORY[game]) return [];

  // The SET first, always. A collector number is only unique inside one set —
  // "1" is a card in every Pokemon set ever printed — so a lookup that is not
  // scoped to a set is the same wrong-card bug in a new place.
  const group = await groupFor(game, number, a.setName ?? null);
  if (!group) return [];

  const key = numberKey(number);
  if (!key) return [];

  const read = async () => {
    const r = await pool.query(
      `select product_id, name, variant, rarity, image_url, url, sub_type,
              market_usd, low_usd, high_usd, listed_usd, listed_cond, fetched_at
         from printings
        where game = $1 and group_id = $2 and number_key = $3
        order by coalesce(listed_usd, market_usd, 0) desc`,
      [game, group.groupId, key],
    );
    return r.rows;
  };

  let rows = await read();
  const stale =
    !rows.length ||
    Date.now() - new Date(rows[0].fetched_at).getTime() > STALE_MS;

  if (stale) {
    const lock = `${game}:${group.groupId}`;
    // One download per set, however many callers arrive at once.
    let job = inFlight.get(lock);
    if (!job) {
      job = ingest(game, group.groupId, group.name).finally(() => inFlight.delete(lock));
      inFlight.set(lock, job);
    }
    try { await job; rows = await read(); } catch { /* stale beats nothing */ }
  }

  // The asking market for this one card, fetched on the way past.
  //
  // An ask is what a card is going for TODAY; a sale is what one went for at
  // some point in the past, and on a card that trades a few times a year that
  // past can be months old. So the ask leads, and it is fetched per card
  // viewed rather than per set — a set ingest would spend one feed request
  // per card number in it, which for a 173-card set is 173 requests to
  // answer a question nobody asked.
  const asks = await asksByProduct(game, number);
  if (asks.size) {
    // Written back so the next reader has it without another request.
    await Promise.all(
      [...asks].map(([pid, a]) =>
        pool.query(
          `update printings set listed_usd = $2, listed_cond = $3 where product_id = $1`,
          [pid, a.usd, a.condition],
        ).catch(() => {}),
      ),
    );
  }

  return rows.map((r: any) => ({
    productId: Number(r.product_id),
    name: r.name,
    variant: r.variant ?? null,
    rarity: r.rarity ?? null,
    imageUrl: r.image_url ?? null,
    url: r.url ?? null,
    subType: r.sub_type ?? null,
    marketUsd: r.market_usd == null ? null : Number(r.market_usd),
    lowUsd: r.low_usd == null ? null : Number(r.low_usd),
    highUsd: r.high_usd == null ? null : Number(r.high_usd),
    listedUsd: asks.get(Number(r.product_id))?.usd ?? (r.listed_usd == null ? null : Number(r.listed_usd)),
    listedCondition: asks.get(Number(r.product_id))?.condition ?? r.listed_cond ?? null,
  }));
}

/** Do these printings disagree enough that one number for all of them is a
 *  lie? Under this ratio a single figure is a fair summary; over it, quoting
 *  the base price for a card that might be the chase printing is the exact
 *  defect this table exists to end. */
export const SPREAD_LIMIT = 3;

export function priceIsAmbiguous(list: Printing[]): boolean {
  const priced = list.map((p) => p.listedUsd ?? p.marketUsd).filter((n): n is number => n != null && n > 0);
  if (priced.length < 2) return false;
  return Math.max(...priced) / Math.min(...priced) > SPREAD_LIMIT;
}
