import { storePool, initStore } from "../cards.store.js";

// Seed the catalogue registry from prices we already hold.
//
// grade_prices has been accumulating rows keyed by catalog_id since it was
// added, but catalog_cards — the work list the refresh job reads — starts
// empty. Without this, every card we have already paid to price is invisible
// to the job and would be re-discovered only when somebody happens to scan it
// again, which is the per-request behaviour we are trying to leave behind.
//
// The names come from TCGdex, which is free, so the backfill costs nothing.
// It is idempotent: run it as often as you like.

const TCGDEX = process.env.TCGDEX_URL ?? "https://api.tcgdex.net/v2/en";

type Backfilled = { seen: number; named: number; skipped: number };

export async function backfillCatalogCards(): Promise<Backfilled> {
  const out: Backfilled = { seen: 0, named: 0, skipped: 0 };
  if (!(await initStore())) return out;
  const p = storePool();
  if (!p) return out;

  // Carry the real last-priced time across. Defaulting last_seen_at to now()
  // would mark every backfilled card as recently-looked-at, which is the exact
  // condition that puts a card in the `hot` tier and buys it a fresh price
  // every day. A backfill must not invent demand that never happened.
  const { rows } = await p.query(
    `SELECT g.catalog_id, MAX(g.fetched_at) AS last_priced
     FROM grade_prices g
     LEFT JOIN catalog_cards c ON c.catalog_id = g.catalog_id
     WHERE c.catalog_id IS NULL
     GROUP BY g.catalog_id`,
  );
  out.seen = rows.length;
  if (rows.length === 0) {
    console.log("[backfill] catalogue registry already covers every priced card");
    return out;
  }
  console.log(`[backfill] ${rows.length} priced cards missing from the registry`);

  for (const r of rows) {
    const id = String(r.catalog_id);
    try {
      const res = await fetch(`${TCGDEX}/cards/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) {
        // A catalog_id TCGdex does not recognise is not necessarily wrong — it
        // may belong to another game's catalogue. Leave it out rather than
        // registering a card under a name we invented.
        out.skipped++;
        continue;
      }
      const d = (await res.json()) as Record<string, any>;
      if (!d?.name) {
        out.skipped++;
        continue;
      }
      await p.query(
        `INSERT INTO catalog_cards
           (catalog_id, game, name, set_name, card_number, seen_count, last_seen_at)
         VALUES ($1,'pokemon',$2,$3,$4,0,COALESCE($5, now()))
         ON CONFLICT (catalog_id) DO NOTHING`,
        [
          id, d.name, d.set?.name ?? null,
          d.localId != null ? String(d.localId) : null,
          r.last_priced ?? null,
        ],
      );
      out.named++;
      console.log(`[backfill]   ${id} -> ${d.name} (${d.set?.name ?? "?"})`);
    } catch (err) {
      out.skipped++;
      console.warn(`[backfill]   ${id} skipped :: ${(err as Error).message}`);
    }
  }

  console.log(`[backfill] registered ${out.named}, skipped ${out.skipped}`);
  return out;
}
