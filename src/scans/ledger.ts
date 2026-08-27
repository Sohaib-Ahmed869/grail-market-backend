import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { storePool, storeConfigured, initStore } from "../cards.store.js";
import { db } from "../db.js";

// A record of every scan, and what each one cost.
//
// The count used to live in a SQLite file under the working directory. That
// file is real and it does survive a restart — but it does not survive a
// deploy on a host with an ephemeral disk, it does not survive the repo moving,
// and two instances each keep their own. So the number people read drifted from
// the number that happened, which is worse than having no number.
//
// It also answered the wrong question. "16 scans" was never a count of scans
// performed; it was an estimate of how many MORE the metered quota would allow,
// derived from a provider's remaining credits. A cached card costs no credits,
// so scanning one moved the figure not at all and the display looked stuck.
//
// So both are recorded, separately and honestly: what we have done, from an
// append-only ledger, and what we can still do, from provider quotas. The
// ledger is append-only on purpose — a usage record that can be rewritten
// cannot be reconciled against a provider's bill.

export type ScanCost = Record<string, number>;

type Ctx = { scanId: string; credits: ScanCost };
const ctx = new AsyncLocalStorage<Ctx>();

let ready: Promise<boolean> | null = null;
function ensure(): Promise<boolean> {
  ready ??= (async () => {
    if (!storeConfigured() || !(await initStore())) return false;
    const p = storePool();
    if (!p) return false;
    try {
      await p.query(`
        CREATE TABLE IF NOT EXISTS scan_ledger (
          id            TEXT PRIMARY KEY,
          at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          instance      TEXT,
          outcome       TEXT NOT NULL,
          card_name     TEXT,
          set_name      TEXT,
          card_number   TEXT,
          grader        TEXT,
          grade         NUMERIC,
          price_usd     NUMERIC,
          price_source  TEXT,
          -- what this scan cost each metered provider; {} means it was served
          -- entirely from cache and cost nothing
          credits       JSONB NOT NULL DEFAULT '{}'::jsonb,
          billable      BOOLEAN NOT NULL DEFAULT false
        );
        CREATE INDEX IF NOT EXISTS scan_ledger_at ON scan_ledger (at DESC);

        -- The backlog.
        --
        -- House rule: log every result below MEDIUM confidence with its
        -- inputs. Without it, the cards we answer badly are invisible — a
        -- weak answer looks exactly like a strong one from the outside, and
        -- the only cases we ever hear about are the ones a user bothers to
        -- complain about. That is a terrible sampling strategy for a system
        -- whose whole promise is that it would rather say nothing than say
        -- something wrong.
        --
        -- Inputs, not just outcomes: the point is to be able to reproduce the
        -- case as a fixture later, and a row that records only "low
        -- confidence" tells you nothing you can act on.
        CREATE TABLE IF NOT EXISTS low_confidence_log (
          id           TEXT PRIMARY KEY,
          at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          scan_id      TEXT,
          reason       TEXT NOT NULL,
          card_name    TEXT,
          set_name     TEXT,
          card_number  TEXT,
          catalog_id   TEXT,
          game         TEXT,
          grader       TEXT,
          grade        NUMERIC,
          confidence   TEXT,
          sample_size  INTEGER,
          price_usd    NUMERIC,
          price_source TEXT,
          -- everything that went in: ocr candidates, set code, which sources
          -- were tried and what each said
          inputs       JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS low_confidence_at ON low_confidence_log (at DESC);
        CREATE INDEX IF NOT EXISTS low_confidence_reason ON low_confidence_log (reason);
      `);
      return true;
    } catch (err) {
      console.warn(`[ledger] unavailable: ${(err as Error).message}`);
      return false;
    }
  })();
  return ready;
}

// Local mirror, so a scan is still counted when the shared store is down or
// unconfigured. Reconciled by id, never double-counted.
db.exec(`
  CREATE TABLE IF NOT EXISTS scan_ledger_local (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    credits TEXT NOT NULL DEFAULT '{}',
    billable INTEGER NOT NULL DEFAULT 0,
    synced INTEGER NOT NULL DEFAULT 0
  );
`);
const localInsert = db.prepare(
  "INSERT OR REPLACE INTO scan_ledger_local (id, at, outcome, credits, billable, synced) VALUES (?, ?, ?, ?, ?, ?)",
);
const localCount = db.prepare(
  "SELECT COUNT(*) AS n FROM scan_ledger_local WHERE at >= ?",
);

const INSTANCE = process.env.RENDER_INSTANCE_ID ?? process.env.HOSTNAME ?? "local";

/** Run a scan inside a context that collects what it spends. */
export function withScan<T>(fn: (scanId: string) => Promise<T>): Promise<T> {
  const scanId = randomUUID();
  return ctx.run({ scanId, credits: {} }, () => fn(scanId));
}

/** Charge the scan in flight. Called by recordUsage, so every provider adapter
 *  gets this for free rather than each remembering to report. */
export function chargeScan(provider: string, units: number): void {
  const c = ctx.getStore();
  if (!c) return; // a call outside a scan — a search, or a warm-up
  c.credits[provider] = (c.credits[provider] ?? 0) + units;
}

export type ScanRecord = {
  id: string;
  outcome: "identified" | "rejected" | "failed";
  cardName?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  grader?: string | null;
  grade?: number | null;
  priceUsd?: number | null;
  priceSource?: string | null;
};

export async function recordScan(r: ScanRecord): Promise<void> {
  const credits = ctx.getStore()?.credits ?? {};
  const billable = Object.values(credits).some((n) => n > 0);
  const at = new Date().toISOString();

  try {
    localInsert.run(r.id, at, r.outcome, JSON.stringify(credits), billable ? 1 : 0, 0);
  } catch {
    /* counting must never break a scan */
  }

  if (!(await ensure())) return;
  const p = storePool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO scan_ledger
         (id, instance, outcome, card_name, set_name, card_number, grader, grade,
          price_usd, price_source, credits, billable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        r.id, INSTANCE, r.outcome, r.cardName ?? null, r.setName ?? null,
        r.cardNumber ?? null, r.grader ?? null, r.grade ?? null,
        r.priceUsd ?? null, r.priceSource ?? null,
        JSON.stringify(credits), billable,
      ],
    );
  } catch (err) {
    console.warn(`[ledger] write failed: ${(err as Error).message}`);
  }
}

export type ScanCounts = {
  /** true when these come from the shared store rather than one instance's disk */
  shared: boolean;
  today: number;
  month: number;
  total: number;
  /** scans that actually spent provider credits; the rest came from cache */
  billableToday: number;
  creditsToday: ScanCost;
  lastScanAt: string | null;
};

export async function scanCounts(): Promise<ScanCounts> {
  const dayStart = new Date().toISOString().slice(0, 10);
  if (await ensure()) {
    const p = storePool();
    if (p) {
      try {
        const { rows } = await p.query(`
          SELECT
            COUNT(*) FILTER (WHERE at >= date_trunc('day',   now()))   AS today,
            COUNT(*) FILTER (WHERE at >= date_trunc('month', now()))   AS month,
            COUNT(*)                                                   AS total,
            COUNT(*) FILTER (WHERE at >= date_trunc('day', now()) AND billable) AS billable_today,
            MAX(at)                                                    AS last_at
          FROM scan_ledger
        `);
        const spend = await p.query(`
          SELECT k AS provider, SUM(v::numeric) AS units
          FROM scan_ledger, jsonb_each_text(credits) AS e(k, v)
          WHERE at >= date_trunc('day', now())
          GROUP BY k
        `);
        const r = rows[0] ?? {};
        return {
          shared: true,
          today: Number(r.today ?? 0),
          month: Number(r.month ?? 0),
          total: Number(r.total ?? 0),
          billableToday: Number(r.billable_today ?? 0),
          creditsToday: Object.fromEntries(
            spend.rows.map((x: any) => [x.provider, Number(x.units)]),
          ),
          lastScanAt: r.last_at ? new Date(r.last_at).toISOString() : null,
        };
      } catch (err) {
        console.warn(`[ledger] read failed: ${(err as Error).message}`);
      }
    }
  }

  // Local fallback — one instance's view, and labelled as such.
  const n = (localCount.get(dayStart) as { n: number } | undefined)?.n ?? 0;
  const all = (db.prepare("SELECT COUNT(*) AS n FROM scan_ledger_local").get() as any)?.n ?? 0;
  return {
    shared: false,
    today: n,
    month: all,
    total: all,
    billableToday: 0,
    creditsToday: {},
    lastScanAt: null,
  };
}

export type WeakResult = {
  scanId: string;
  /** why this is in the backlog: no-price | low-confidence | tiny-sample |
   *  no-identification | estimated-only */
  reason: string;
  cardName?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  catalogId?: string | null;
  game?: string | null;
  grader?: string | null;
  grade?: number | null;
  confidence?: string | null;
  sampleSize?: number | null;
  priceUsd?: number | null;
  priceSource?: string | null;
  inputs?: Record<string, unknown>;
};

/** Record a result we are not confident in, with enough of its inputs to
 *  rebuild it as a fixture. Best-effort and never awaited by a scan. */
export async function recordWeakResult(r: WeakResult): Promise<void> {
  // Always say it out loud too. The table needs the shared store to be up, and
  // the cases worth studying most are often the ones where something was down.
  console.warn(
    `[weak] ${r.reason} :: ${r.cardName ?? "unidentified"}` +
      (r.setName ? ` (${r.setName})` : "") +
      (r.grader && r.grade != null ? ` ${r.grader} ${r.grade}` : "") +
      (r.sampleSize != null ? ` n=${r.sampleSize}` : ""),
  );
  if (!(await ensure())) return;
  const p = storePool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO low_confidence_log
         (id, scan_id, reason, card_name, set_name, card_number, catalog_id,
          game, grader, grade, confidence, sample_size, price_usd, price_source, inputs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        randomUUID(), r.scanId, r.reason,
        r.cardName ?? null, r.setName ?? null, r.cardNumber ?? null,
        r.catalogId ?? null, r.game ?? null,
        r.grader ?? null, r.grade ?? null,
        r.confidence ?? null, r.sampleSize ?? null,
        r.priceUsd ?? null, r.priceSource ?? null,
        JSON.stringify(r.inputs ?? {}),
      ],
    );
  } catch (err) {
    console.warn(`[weak] log write failed: ${(err as Error).message}`);
  }
}

/** What a scan has ACTUALLY cost a provider lately, per scan.
 *
 *  The budget used to assume this. Gemini was assumed at 2 requests a scan —
 *  one identify plus one grounded price fallback — but identifyWithGemini
 *  loops over a primary and a fallback model and meters each attempt, and the
 *  identify step itself can fire more than once in a scan (label arbitration,
 *  then the catalog-failure path). A real scan came in at 4. The headline
 *  "scans left" was therefore about twice what the budget could actually buy,
 *  which is the wrong direction for a number people plan against.
 *
 *  So it is measured. Returns null until there is enough history to mean
 *  anything, and the caller keeps its assumption for that case.
 */
export async function observedCostPerScan(
  provider: string,
  minScans = 5,
): Promise<number | null> {
  if (!(await ensure())) return null;
  const p = storePool();
  if (!p) return null;
  try {
    const { rows } = await p.query(
      `SELECT count(*)::int AS scans,
              COALESCE(SUM((credits ->> $1)::numeric), 0) AS units
         FROM scan_ledger
        WHERE at >= now() - interval '30 days'
          AND credits ? $1`,
      [provider],
    );
    const scans = Number(rows[0]?.scans ?? 0);
    const units = Number(rows[0]?.units ?? 0);
    if (scans < minScans || units <= 0) return null;
    return units / scans;
  } catch {
    return null;
  }
}
