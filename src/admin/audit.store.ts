import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";
import { TtlCache } from "../scans/ttlcache.js";

// The audit log.
//
// One table, append-only, written by the controller on every action that
// changes something a member could later challenge. It is the record that gets
// checked when somebody disputes a decision, so:
//
//   - there is no UPDATE and no DELETE in this file, and none anywhere else
//     either. Same rule as `sales_ledger`;
//   - a write that fails must never take the action down with it. An approval
//     that went through and was not logged is bad; an approval refused because
//     the logger was unreachable is worse, and the moderator would simply
//     click it again. `writeAudit` swallows its own errors and says so on the
//     console rather than throwing;
//   - the reason recorded at the time is stored verbatim. It is the whole
//     value of the entry — "restricted an account" without the why is not an
//     audit trail, it is a timestamp.
//
// The console used to hold this in a module-level array in `lib/data.ts`,
// which meant the log was empty on every reload and disagreed between two tabs
// of the same browser.

export const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_audit (
  entry_id   text PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  -- Who. The name is denormalised on purpose: it is what the entry SAID at the
  -- time, and a staff member who later changes their display name must not
  -- retroactively rewrite two years of decisions.
  actor_id   text,
  actor      text NOT NULL,
  -- 'listing' | 'member' | 'conduct' | 'support' | 'billing' | 'pricing'
  -- | 'settings' | 'staff'
  area       text NOT NULL,
  -- The verb, past tense, as it reads in a list.
  action     text NOT NULL,
  -- What it was done to: a handle, a listing id, a setting name.
  target     text NOT NULL,
  -- The reason recorded at the time, where one was required.
  detail     text,
  -- 'high' where it moved money or standing, 'normal' otherwise.
  weight     text NOT NULL DEFAULT 'normal'
);
CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_area ON admin_audit (area, at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_actor ON admin_audit (actor, at DESC);
`;

export const AREAS = [
  "listing",
  "member",
  "conduct",
  "support",
  "billing",
  "pricing",
  "settings",
  "staff",
] as const;

export type AuditArea = (typeof AREAS)[number];
export const isArea = (a: string): a is AuditArea =>
  (AREAS as readonly string[]).includes(a);

export type AuditEntry = {
  id: string;
  at: string;
  actor: string;
  area: AuditArea;
  action: string;
  target: string;
  detail?: string;
  weight: "high" | "normal";
};

/**
 * Write one entry.
 *
 * Deliberately not awaited at most call sites, and deliberately incapable of
 * throwing. See the note at the top: the action is the thing that matters, and
 * a logger that can veto it is a logger that will one day stop the console
 * working. A dropped entry is loud in the server log instead.
 *
 * Returns the id it wrote, or null if it could not. Every caller in the
 * controller ignores it; the seed script uses it to date its entries, which is
 * the only thing in the codebase that needs to name an entry after writing it.
 */
export async function writeAudit(e: {
  actorId?: string | null;
  actor: string;
  area: AuditArea;
  action: string;
  target: string;
  detail?: string | null;
  weight?: "high" | "normal";
}): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  const id = `au_${randomUUID().slice(0, 12)}`;
  try {
    await pool.query(
      `insert into admin_audit
         (entry_id, actor_id, actor, area, action, target, detail, weight)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        e.actorId ?? null,
        e.actor.slice(0, 120),
        e.area,
        e.action.slice(0, 200),
        e.target.slice(0, 200),
        e.detail ? e.detail.slice(0, 2000) : null,
        e.weight ?? "normal",
      ],
    );
    return id;
  } catch (err) {
    console.error("[audit] entry dropped:", (err as Error).message, e.action, e.target);
    return null;
  }
}

/**
 * The log, filtered.
 *
 * Filtering is the database's job. The console used to hold every entry and
 * cut it down in the browser, which is fine at thirteen rows and not at the
 * seven years of retention the page promises underneath itself.
 */
export async function auditEntries(q: {
  area?: string | null;
  actor?: string | null;
  weight?: string | null;
  search?: string | null;
  limit?: number;
}): Promise<AuditEntry[]> {
  const pool = storePool();
  if (!pool) return [];

  const args: any[] = [];
  const where: string[] = [];

  if (q.area && q.area !== "all" && isArea(q.area)) {
    args.push(q.area);
    where.push(`area = $${args.length}`);
  }
  if (q.actor && q.actor !== "all") {
    args.push(q.actor);
    where.push(`actor = $${args.length}`);
  }
  /* Only one direction is worth offering. "Normal only" is not a question
     anybody asks of an audit log — the consequential entries are why you
     opened it. */
  if (q.weight === "high") where.push("weight = 'high'");

  if (q.search) {
    args.push(`%${q.search.trim()}%`);
    const n = args.length;
    where.push(
      `(action ilike $${n} or target ilike $${n} or actor ilike $${n} or detail ilike $${n})`,
    );
  }

  args.push(Math.min(q.limit ?? 300, 1000));
  const r = await pool.query(
    `select entry_id, at, actor, area, action, target, detail, weight
       from admin_audit
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by at desc
      limit $${args.length}`,
    args,
  );
  return r.rows.map(shape);
}

/**
 * The two figures the page needs but the filters do not change.
 *
 * The operator list and the totals are the same answer whatever is typed in
 * the search box, and the console re-reads the log on every keystroke. Without
 * this, each letter cost a `SELECT DISTINCT` and two `count(*)` over the whole
 * table — three sequential scans, per character, of the one table in this
 * system that only ever grows and is kept for seven years.
 *
 * Half a minute is the right staleness: an operator who has just taken a
 * decision wants to see it in the list, which they will, because the entries
 * themselves are never cached. What can lag is whether a colleague's name has
 * appeared in a dropdown.
 */
const SIDECAR = new TtlCache<{ actors: string[]; totals: { all: number; high: number } }>(
  30_000,
  1,
);

async function sidecar() {
  const hit = SIDECAR.get("log");
  if (hit) return hit;
  const [actors, totals] = await Promise.all([readActors(), readTotals()]);
  const v = { actors, totals };
  SIDECAR.set("log", v);
  return v;
}

/** Every name that has written to the log, for the operator filter. */
export async function auditActors(): Promise<string[]> {
  return (await sidecar()).actors;
}

async function readActors(): Promise<string[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query("select distinct actor from admin_audit order by actor");
  return r.rows.map((x: any) => x.actor as string);
}

/**
 * How many entries there are, and how many of them were consequential.
 *
 * Counted over the whole log rather than over the filtered page, because the
 * caption says "N of M" and M has to be the total or the sentence is a
 * tautology.
 */
export async function auditTotals(): Promise<{ all: number; high: number }> {
  return (await sidecar()).totals;
}

async function readTotals(): Promise<{ all: number; high: number }> {
  const pool = storePool();
  if (!pool) return { all: 0, high: 0 };
  const r = await pool.query(
    `select count(*)::int all_n,
            count(*) filter (where weight = 'high')::int high_n
       from admin_audit`,
  );
  return { all: r.rows[0]?.all_n ?? 0, high: r.rows[0]?.high_n ?? 0 };
}

/** A row, in the console's words. Exported for the test — this mapping is
 *  where a log quietly starts disagreeing with the table under it. */
export function shape(row: any): AuditEntry {
  return {
    id: row.entry_id,
    at: new Date(row.at).toISOString(),
    actor: row.actor,
    area: isArea(row.area) ? row.area : "settings",
    action: row.action,
    target: row.target,
    detail: row.detail ?? undefined,
    weight: row.weight === "high" ? "high" : "normal",
  };
}
