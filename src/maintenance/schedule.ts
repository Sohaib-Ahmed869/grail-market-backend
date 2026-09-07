// When a background job is allowed to run.
//
// There is no cron here and no worker process, on purpose. A scheduler is a
// second thing to deploy, pay for and keep alive, and the jobs this product
// needs are daily at most. So they ride on traffic: every request glances at
// a clock, and the first one that finds work due starts it in the background.
//
// That makes correctness a question of two guards, both of which are pure and
// both of which are tested here:
//
//   1. Cheap in memory, so the common case — a request arriving when nothing
//      is due — costs a subtraction and touches no database.
//   2. Correct in the database, so two instances that both wake up at 3am do
//      not both do the work.

export type Job = { name: string; everyMs: number };

export const DAILY = 24 * 60 * 60 * 1000;

/** Is it worth ASKING the database whether this job is due?
 *
 *  Deliberately optimistic: it says yes on the first call of a process and
 *  after the interval has passed locally. The database has the real answer;
 *  this only exists to keep the common case off it. */
export function worthChecking(
  lastLocalCheck: number | null,
  everyMs: number,
  now = Date.now(),
): boolean {
  if (lastLocalCheck == null) return true;
  // A tenth of the interval. Checking every request would put a query on the
  // hot path; checking once per interval would mean a restarted instance
  // waits a whole day to notice work it should have picked up.
  return now - lastLocalCheck >= Math.max(60_000, everyMs / 10);
}

/** Given what the database says, is the job actually due? */
export function isDue(lastRunAt: Date | string | number | null | undefined, everyMs: number, now = Date.now()): boolean {
  if (lastRunAt == null) return true;
  const t = new Date(lastRunAt).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t >= everyMs;
}

/** How long a claim on a job stays valid before another instance may retry.
 *
 *  A process that dies mid-job leaves its claim behind. Without a lease the
 *  job never runs again; with one that is too short, two instances overlap.
 *  An hour is far longer than any of these take and far shorter than the
 *  daily interval they run on. */
export const LEASE_MS = 60 * 60 * 1000;

/** May this instance take the job, given the claim currently on it? */
export function canClaim(
  claimedAt: Date | string | number | null | undefined,
  now = Date.now(),
): boolean {
  if (claimedAt == null) return true;
  const t = new Date(claimedAt).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t >= LEASE_MS;
}
