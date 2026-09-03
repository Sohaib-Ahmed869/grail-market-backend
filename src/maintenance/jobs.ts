import { storePool } from "../cards.store.js";
import { canClaim, isDue, worthChecking, DAILY, type Job } from "./schedule.js";

// The background work, and the machinery that decides when it runs.
//
// Nothing here calls a paid API. That is the design constraint, not an
// accident: a scheduled job that spends money is a bill that arrives whether
// or not anybody opened the app, and the two jobs below are both rearrangements
// of data we have already bought.

export const MAINTENANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS maintenance (
  job         text PRIMARY KEY,
  last_run_at timestamptz,
  claimed_at  timestamptz,
  last_note   text
);
`;

export async function initMaintenance(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(MAINTENANCE_SCHEMA);
}

/** Today's prices, written into the history table.
 *
 *  grade_prices is a CURRENT-value table — the refresh upserts it, so it only
 *  ever holds one figure per card and yesterday's is gone. price_points is the
 *  series. Copying one into the other costs a single statement and no network
 *  call at all: the prices have already been paid for, and the only thing that
 *  was missing was writing down the date we saw them.
 *
 *  Dated by `fetched_at` rather than by today, so a row we bought on Tuesday
 *  lands on Tuesday. That also makes the first run a backfill of every price
 *  already in the table, which is where the history comes from at all.
 */
async function snapshotPrices(): Promise<string> {
  const pool = storePool();
  if (!pool) return "no store";
  const r = await pool.query(`
    insert into price_points
      (catalog_id, grader, grade, qualifier, label_variant,
       price, low, high, sample_size, confidence, source, day)
    select catalog_id, grader, grade,
           coalesce(qualifier, ''), coalesce(label_variant, ''),
           price, low, high, sample_size, confidence, source,
           fetched_at::date
      from grade_prices
     where price is not null and fetched_at is not null
    on conflict (catalog_id, grader, grade, qualifier, label_variant, day)
    do update set
      price = excluded.price, low = excluded.low, high = excluded.high,
      sample_size = excluded.sample_size, confidence = excluded.confidence,
      source = excluded.source
  `);
  return `${r.rowCount ?? 0} points`;
}

/** Points older than two years, removed.
 *
 *  A series nobody can draw is a table that only grows. The charts offer at
 *  most a year, so anything past two is storage being paid for to hold data
 *  no screen can ask for.
 */
async function prunePoints(): Promise<string> {
  const pool = storePool();
  if (!pool) return "no store";
  const r = await pool.query(
    "delete from price_points where day < current_date - interval '2 years'",
  );
  return `${r.rowCount ?? 0} pruned`;
}

const JOBS: (Job & { run: () => Promise<string> })[] = [
  { name: "snapshot-prices", everyMs: DAILY, run: snapshotPrices },
  { name: "prune-points", everyMs: 7 * DAILY, run: prunePoints },
];

/** When this process last bothered to ask the database. */
const lastLocalCheck = new Map<string, number>();

/** Take the job if it is due and unclaimed. One statement, and the WHERE is
 *  what makes it safe: two instances issuing this at the same moment, only one
 *  updates a row. */
async function claim(job: Job): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const now = Date.now();

  const seen = await pool.query(
    "select last_run_at, claimed_at from maintenance where job = $1",
    [job.name],
  );
  const row = seen.rows[0];
  if (row && !isDue(row.last_run_at, job.everyMs, now)) return false;
  if (row && !canClaim(row.claimed_at, now)) return false;

  const taken = await pool.query(
    `insert into maintenance (job, claimed_at) values ($1, now())
     on conflict (job) do update set claimed_at = now()
     where maintenance.claimed_at is null
        or maintenance.claimed_at < now() - interval '1 hour'
     returning job`,
    [job.name],
  );
  return (taken.rowCount ?? 0) > 0;
}

async function finish(name: string, note: string): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(
    `update maintenance set last_run_at = now(), claimed_at = null, last_note = $2
      where job = $1`,
    [name, note.slice(0, 200)],
  );
}

/** Called from the request path. Returns immediately; anything due runs after.
 *
 *  Never awaited by a caller and never able to fail one: a maintenance job
 *  that breaks a page is worse than a maintenance job that does not run. */
export function tickMaintenance(): void {
  if (!storePool()) return;

  for (const job of JOBS) {
    if (!worthChecking(lastLocalCheck.get(job.name) ?? null, job.everyMs)) continue;
    lastLocalCheck.set(job.name, Date.now());

    void (async () => {
      try {
        if (!(await claim(job))) return;
        const note = await job.run();
        await finish(job.name, note);
        console.log(`[maintenance] ${job.name}: ${note}`);
      } catch (err) {
        // Release the claim so the next instance can try, and say what
        // happened — a job that fails silently every night is indistinguishable
        // from one that is not scheduled.
        console.warn(`[maintenance] ${job.name} failed: ${(err as Error).message}`);
        await finish(job.name, `failed: ${(err as Error).message}`).catch(() => {});
      }
    })();
  }
}
