import { storePool } from "../cards.store.js";
import { asFinish } from "./sku.js";

// Filling in the SKU axes on cards we already hold, from data we already
// bought. No provider call — this is a rearrangement, per the cost rule.
//
// THE TRAP, and why this is not a one-line UPDATE ... FROM.
//
// The obvious join is catalog_cards.card_number = printings.number_key. It is
// wrong, and measurably so: `optcg-OP17-022` (Shanks) and `optcg-OP17-022_p2`
// (Shanks, Manga) BOTH match every printing of OP17-022, and those printings
// carry different variants — Alternate Art, Manga, and the base. The collector
// number is precisely the thing every variant of a card SHARES, so joining on
// it hands each card several candidate finishes and no way to choose.
//
// Writing one anyway would put the Manga printing's treatment on the base card
// in the permanent catalogue, which is the same failure as pricing a
// Shadowless off Unlimited sales — the exact thing the SKU exists to stop.
//
// So: a card is only written when the candidates AGREE. Where they disagree
// the row is left null and counted, because "we do not know this card's
// finish" is a true statement and a guess is not.

/** The decision, separated from the query so it can be pinned by fixtures.
 *
 *  Given every sub_type a card could correspond to, either one finish or
 *  nothing. Normalisation happens BEFORE the agreement test on purpose:
 *  "Holofoil" and "Holo Rare" are one finish written two ways, and treating
 *  them as a disagreement would throw away a card we do know about. */
export function agreedFinish(subTypes: readonly (string | null)[]): string | null {
  const finishes = new Set(
    subTypes.filter(Boolean).map((s) => asFinish(s)).filter(Boolean) as string[],
  );
  return finishes.size === 1 ? [...finishes][0]! : null;
}

export type BackfillReport = {
  considered: number;
  written: number;
  /** candidates disagreed — left null on purpose */
  ambiguous: number;
  /** no printing matched at all */
  unmatched: number;
  /** already had a value; never overwritten */
  skipped: number;
  examples: { catalogId: string; saw: string[] }[];
};

/** Derive `finish` for every catalogue card that does not have one.
 *
 *  `dryRun` reports what it would do and writes nothing, which is how this
 *  should be run the first time against a real catalogue. */
export async function backfillFinish(opts: { dryRun?: boolean; limit?: number } = {}): Promise<BackfillReport> {
  const report: BackfillReport = {
    considered: 0, written: 0, ambiguous: 0, unmatched: 0, skipped: 0, examples: [],
  };
  const pool = storePool();
  if (!pool) return report;

  // Every distinct sub_type each card could correspond to, gathered in one
  // pass rather than a query per card.
  const rows = await pool.query(
    `select c.catalog_id,
            c.finish as current,
            array_remove(array_agg(distinct p.sub_type), null) as sub_types
       from catalog_cards c
       left join printings p
         on p.game = c.game and p.number_key = c.card_number
      group by c.catalog_id, c.finish
      limit $1`,
    [Math.min(opts.limit ?? 5000, 20000)],
  );

  const updates: { id: string; finish: string }[] = [];

  for (const r of rows.rows as { catalog_id: string; current: string | null; sub_types: string[] }[]) {
    report.considered++;
    if (r.current) { report.skipped++; continue; }

    const seen = (r.sub_types ?? []).filter(Boolean);
    if (!seen.length) { report.unmatched++; continue; }

    const finish = agreedFinish(seen);
    if (!finish) {
      report.ambiguous++;
      if (report.examples.length < 8) {
        report.examples.push({ catalogId: r.catalog_id, saw: seen });
      }
      continue;
    }
    updates.push({ id: r.catalog_id, finish });
  }

  if (!opts.dryRun && updates.length) {
    // One statement, not one per card.
    await pool.query(
      `update catalog_cards c set finish = v.finish
         from (select unnest($1::text[]) as id, unnest($2::text[]) as finish) v
        where c.catalog_id = v.id and c.finish is null`,
      [updates.map((u) => u.id), updates.map((u) => u.finish)],
    );
  }
  report.written = updates.length;
  return report;
}
