// Measure the estimator against sales it never saw.
//
//   npm run backtest            # every sold comp with 8+ sales
//   npm run backtest -- --min 15
//
// The estimator is shown ONLY live asking prices for a card, and its answer is
// compared with the completed-sale figure our store holds for the same
// (card, grader, grade). The sold figure is the answer key and is never an
// input. Reads prices from our own store, so the only network calls are to
// eBay for the asks — no metered provider credits are spent.
//
// This exists so the accuracy figures we publish can be re-run rather than
// taken on trust. Numbers move as the market does; re-run before quoting them.
import { loadEnvFile } from "../env.js";
loadEnvFile();

import { writeFileSync } from "node:fs";
import { fetchListings } from "../scans/ebaylistings.js";
import { estimateFromListings, isRefusal } from "../scans/estimate.js";
import { storePool, initStore } from "../cards.store.js";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};
const MIN_SALES = Number(flag("--min") ?? 8);
const CONCURRENCY = Number(flag("--jobs") ?? 4);
const OUT = flag("--out");

type Row = {
  card: string; set: string | null; num: string | null; game: string | null;
  grader: string; grade: number; sold: number; soldN: number;
  asks: number; medianAsk: number | null; gradeOk: boolean;
  est?: number; conf?: number; err?: number; refused?: string; error?: string;
};

await initStore();
const pool = storePool();
if (!pool) { console.error("[backtest] no store configured — set DATABASE_URL"); process.exit(1); }
const { rows } = await pool.query(
  `select c.name, c.set_name, c.card_number, c.game,
          g.grader, g.grade, g.price::float price, g.sample_size
     from grade_prices g join catalog_cards c using (catalog_id)
    where g.sample_size >= $1 and g.price > 0
    order by c.name, g.grader, g.grade::numeric`,
  [MIN_SALES],
);
console.log(`[backtest] ${rows.length} sold comps with ${MIN_SALES}+ sales`);

const out: Row[] = [];
let done = 0;
const queue = [...rows];

async function worker() {
  for (;;) {
    const r = queue.shift();
    if (!r) return;
    const base = {
      card: r.name, set: r.set_name, num: r.card_number, game: r.game,
      grader: r.grader, grade: Number(r.grade), sold: r.price, soldN: r.sample_size,
    };
    try {
      const live = await fetchListings({
        name: r.name, setName: r.set_name, game: r.game, number: r.card_number,
        grader: r.grader, grade: Number(r.grade),
      });
      if (!live) { out.push({ ...base, asks: 0, medianAsk: null, gradeOk: false, refused: "no-listings" }); continue; }
      const est = estimateFromListings(live.listings ?? [], {
        grader: r.grader, grade: Number(r.grade),
      });
      const rec: Row = {
        ...base,
        asks: (live.listings ?? []).length,
        medianAsk: live.medianAsk ?? null,
        gradeOk: Boolean(live.filteredToGrade),
      };
      if (isRefusal(est)) rec.refused = est.reason;
      else {
        rec.est = est.estimate;
        rec.conf = est.confidence;
        rec.err = (est.estimate - r.price) / r.price;
      }
      out.push(rec);
    } catch (e: any) {
      out.push({ ...base, asks: 0, medianAsk: null, gradeOk: false, error: String(e?.message).slice(0, 90) });
    }
    if (++done % 10 === 0) console.log(`[backtest] ${done}/${rows.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ---- report -----------------------------------------------------------------
const priced = out.filter((r) => r.err != null);
const refused = out.filter((r) => r.refused);
const errored = out.filter((r) => r.error);
const abs = priced.map((r) => Math.abs(r.err as number)).sort((a, b) => a - b);
const signed = priced.map((r) => r.err as number).sort((a, b) => a - b);
const med = (a: number[]) =>
  a.length === 0 ? NaN : a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
const within = (p: number) => abs.filter((e) => e <= p).length / (abs.length || 1);

// what the asks actually implied, independent of the constant we applied
const ratios = out
  .filter((r) => r.medianAsk != null && r.medianAsk > 0)
  .map((r) => r.sold / (r.medianAsk as number))
  .sort((a, b) => a - b);

console.log(`
[backtest] ================ RESULT ================
  keys tested            ${out.length}
  priced                 ${priced.length}
  refused                ${refused.length}  ${refused.map((r) => r.refused).join(",")}
  errored                ${errored.length}
  median absolute error  ${(med(abs) * 100).toFixed(1)}%
  median signed error    ${(med(signed) * 100 >= 0 ? "+" : "") + (med(signed) * 100).toFixed(1)}%
  within +/-25%          ${(within(0.25) * 100).toFixed(0)}%
  within +/-50%          ${(within(0.5) * 100).toFixed(0)}%
  implied sold/medianAsk ${med(ratios).toFixed(3)}  (n=${ratios.length})
[backtest] ========================================`);

const worst = [...priced].sort((a, b) => Math.abs(b.err as number) - Math.abs(a.err as number)).slice(0, 8);
console.log("[backtest] furthest off:");
for (const r of worst) {
  console.log(
    `  ${((r.err as number) * 100 >= 0 ? "+" : "") + ((r.err as number) * 100).toFixed(0)}%`.padEnd(9) +
      `${r.grader} ${r.grade}`.padEnd(10) +
      `sold $${r.sold.toFixed(0)} (n=${r.soldN})  est $${(r.est as number).toFixed(0)} from ${r.asks} asks  — ${r.card} ${r.set ?? ""}`,
  );
}
if (OUT) { writeFileSync(OUT, JSON.stringify(out, null, 1)); console.log(`[backtest] wrote ${OUT}`); }
process.exit(0);
