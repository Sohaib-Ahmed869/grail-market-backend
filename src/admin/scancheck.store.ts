import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";

// The scan checker: real card photos through the real pipeline, and a person's
// verdict on each answer.
//
// This is how scan accuracy is measured instead of asserted. The rule the
// scanner is held to is that it is NEVER confidently wrong: an answer marked
// verified (a catalogue card whose printing was proven) must be right every
// time. So the number that matters most here is "verified and wrong", and its
// target is zero. Coverage — how many cards verify at all — is the number that
// is allowed to grow over time.
//
// Each check keeps the image it was run on (the scan pipeline stores it under
// storage/<scanId>/front.jpg), so every labelled card can be re-run after a
// change to the pipeline. That re-run is the regression test.

export const SCAN_CHECK_SCHEMA = `
CREATE TABLE IF NOT EXISTS scan_checks (
  check_id            text PRIMARY KEY,
  source_scan_id      text NOT NULL,
  scan_id             text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text,
  created_by_name     text,
  result              jsonb NOT NULL,
  verdict             text,
  expected_name       text,
  expected_set        text,
  expected_number     text,
  expected_catalog_id text,
  note                text,
  judged_by           text,
  judged_at           timestamptz,
  runs                integer NOT NULL DEFAULT 1,
  last_run_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scan_checks_created ON scan_checks (created_at DESC);
`;

// ---- pure ------------------------------------------------------------------------

export type ScanSnapshot = {
  status: string;
  rejection: string | null;
  identification: {
    cardId: string;
    name: string;
    setName: string;
    localId: string;
    game: string;
    matchScore: number | null;
    printingConfirmed: boolean | null;
    unconfirmedReason: string | null;
    imageUrl: string | null;
  } | null;
  price: { value: number; currency: string; basis: string } | null;
  candidates: { cardId: string; name: string; setName: string; localId: string }[];
  ocrNames: string[];
};

/** What a scan answered, kept small enough to store per check and compare
 *  across re-runs. The full scan record stays in the scan store. */
export function snapshotOf(scan: any): ScanSnapshot {
  const i = scan?.identification ?? null;
  const v = scan?.valuation ?? null;
  const price =
    v?.slabPrice?.price != null
      ? { value: Number(v.slabPrice.price), currency: String(v.currency ?? "USD"), basis: "slab" }
      : v?.tcgplayer?.market != null
        ? { value: Number(v.tcgplayer.market), currency: String(v.tcgplayer.unit ?? "USD"), basis: String(v.source ?? "market") }
        : v?.cardmarket?.trend != null
          ? { value: Number(v.cardmarket.trend), currency: String(v.cardmarket.unit ?? "EUR"), basis: "cardmarket" }
          : v?.liveAsk?.median != null
            ? { value: Number(v.liveAsk.median), currency: String(v.liveAsk.currency ?? "USD"), basis: "live asks" }
            : null;
  return {
    status: String(scan?.status ?? "unknown"),
    rejection: scan?.rejection?.reason ? String(scan.rejection.reason) : null,
    identification: i
      ? {
          cardId: String(i.cardId ?? ""),
          name: String(i.name ?? ""),
          setName: String(i.setName ?? ""),
          localId: String(i.localId ?? ""),
          game: String(i.game ?? "other"),
          matchScore: typeof i.matchScore === "number" ? i.matchScore : null,
          printingConfirmed: typeof i.printingConfirmed === "boolean" ? i.printingConfirmed : null,
          unconfirmedReason: i.unconfirmedReason ? String(i.unconfirmedReason) : null,
          imageUrl: i.imageUrl ? String(i.imageUrl) : null,
        }
      : null,
    price: price && Number.isFinite(price.value) ? price : null,
    candidates: (scan?.candidates ?? []).slice(0, 8).map((c: any) => ({
      cardId: String(c?.identification?.cardId ?? ""),
      name: String(c?.identification?.name ?? ""),
      setName: String(c?.identification?.setName ?? ""),
      localId: String(c?.identification?.localId ?? ""),
    })),
    ocrNames: Array.isArray(scan?.ocrNames) ? scan.ocrNames.slice(0, 5).map(String) : [],
  };
}

export type Verdict = "correct" | "wrong" | "bad-photo";
export const isVerdict = (v: unknown): v is Verdict =>
  v === "correct" || v === "wrong" || v === "bad-photo";

/** Did the scanner stand behind this answer? A catalogue card whose printing
 *  was proven, on a photo it did not reject. Everything else is a suggestion. */
export function isVerified(s: ScanSnapshot): boolean {
  const i = s.identification;
  return Boolean(
    i && i.cardId && i.cardId !== "llm" && i.cardId !== "described" &&
    i.printingConfirmed !== false && !s.rejection,
  );
}

export type Outcome =
  | "verified-correct"
  | "verified-wrong"
  | "unverified-correct"
  | "unverified-wrong"
  | "no-answer"
  | "bad-photo"
  | "unjudged";

/** One check, scored. "correct" means the answer on screen was right for the
 *  card photographed — name, and set and number wherever it showed them. */
export function outcomeOf(s: ScanSnapshot, verdict: Verdict | null | undefined): Outcome {
  if (!verdict) return "unjudged";
  if (verdict === "bad-photo") return "bad-photo";
  if (!s.identification) return "no-answer";
  if (isVerified(s)) return verdict === "correct" ? "verified-correct" : "verified-wrong";
  return verdict === "correct" ? "unverified-correct" : "unverified-wrong";
}

export type Tally = {
  checks: number;
  judged: number;
  verifiedCorrect: number;
  verifiedWrong: number;
  unverifiedCorrect: number;
  unverifiedWrong: number;
  noAnswer: number;
  badPhoto: number;
  /** verified answers that were right, of verified answers judged. Must be 1. */
  precision: number | null;
  /** cards the scanner verified correctly, of usable photos judged. */
  coverage: number | null;
};

const empty = (): Tally => ({
  checks: 0, judged: 0, verifiedCorrect: 0, verifiedWrong: 0, unverifiedCorrect: 0,
  unverifiedWrong: 0, noAnswer: 0, badPhoto: 0, precision: null, coverage: null,
});

function finish(t: Tally): Tally {
  const verified = t.verifiedCorrect + t.verifiedWrong;
  const usable = t.judged - t.badPhoto;
  return {
    ...t,
    precision: verified > 0 ? t.verifiedCorrect / verified : null,
    coverage: usable > 0 ? t.verifiedCorrect / usable : null,
  };
}

/** Overall and per game. The game is the scanner's own when it named one, and
 *  "unidentified" when it named nothing. */
export function summarize(rows: { result: ScanSnapshot; verdict: Verdict | null }[]): {
  overall: Tally;
  games: Record<string, Tally>;
} {
  const overall = empty();
  const games: Record<string, Tally> = {};
  for (const r of rows) {
    const game = r.result.identification?.game || "unidentified";
    const g = (games[game] ??= empty());
    for (const t of [overall, g]) {
      t.checks++;
      const o = outcomeOf(r.result, r.verdict);
      if (o === "unjudged") continue;
      t.judged++;
      if (o === "verified-correct") t.verifiedCorrect++;
      else if (o === "verified-wrong") t.verifiedWrong++;
      else if (o === "unverified-correct") t.unverifiedCorrect++;
      else if (o === "unverified-wrong") t.unverifiedWrong++;
      else if (o === "no-answer") t.noAnswer++;
      else if (o === "bad-photo") t.badPhoto++;
    }
  }
  return {
    overall: finish(overall),
    games: Object.fromEntries(Object.entries(games).map(([k, v]) => [k, finish(v)])),
  };
}

// ---- store -----------------------------------------------------------------------

let ready: Promise<boolean> | null = null;
function ensure(): Promise<boolean> {
  const pool = storePool();
  if (!pool) return Promise.resolve(false);
  ready ??= pool.query(SCAN_CHECK_SCHEMA).then(() => true, (err) => {
    ready = null;
    console.warn(`[scan-check] schema unavailable :: ${(err as Error).message}`);
    return false;
  });
  return ready;
}

export type CheckRow = {
  id: string;
  sourceScanId: string;
  scanId: string;
  createdAt: string;
  createdBy: string | null;
  result: ScanSnapshot;
  verdict: Verdict | null;
  expected: { name: string | null; set: string | null; number: string | null; catalogId: string | null } | null;
  note: string | null;
  judgedBy: string | null;
  judgedAt: string | null;
  runs: number;
  lastRunAt: string;
  outcome: Outcome;
};

function rowOf(r: any): CheckRow {
  const verdict = isVerdict(r.verdict) ? r.verdict : null;
  const result = r.result as ScanSnapshot;
  const hasExpected = r.expected_name || r.expected_set || r.expected_number || r.expected_catalog_id;
  return {
    id: r.check_id,
    sourceScanId: r.source_scan_id,
    scanId: r.scan_id,
    createdAt: new Date(r.created_at).toISOString(),
    createdBy: r.created_by_name ?? null,
    result,
    verdict,
    expected: hasExpected
      ? { name: r.expected_name, set: r.expected_set, number: r.expected_number, catalogId: r.expected_catalog_id }
      : null,
    note: r.note ?? null,
    judgedBy: r.judged_by ?? null,
    judgedAt: r.judged_at ? new Date(r.judged_at).toISOString() : null,
    runs: Number(r.runs ?? 1),
    lastRunAt: new Date(r.last_run_at).toISOString(),
    outcome: outcomeOf(result, verdict),
  };
}

export async function createCheck(c: {
  scanId: string; actorId: string | null; actorName: string | null; snapshot: ScanSnapshot;
}): Promise<CheckRow | null> {
  if (!(await ensure())) return null;
  const r = await storePool()!.query(
    `insert into scan_checks (check_id, source_scan_id, scan_id, created_by, created_by_name, result)
     values ($1, $2, $2, $3, $4, $5) returning *`,
    [`sc_${randomUUID().slice(0, 12)}`, c.scanId, c.actorId, c.actorName, JSON.stringify(c.snapshot)],
  );
  return rowOf(r.rows[0]);
}

export async function getCheck(id: string): Promise<CheckRow | null> {
  if (!(await ensure())) return null;
  const r = await storePool()!.query("select * from scan_checks where check_id = $1", [id]);
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

export async function judgeCheck(
  id: string,
  j: { verdict: Verdict; name?: string | null; set?: string | null; number?: string | null; catalogId?: string | null; note?: string | null },
  judge: string,
): Promise<CheckRow | null> {
  if (!(await ensure())) return null;
  const clean = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim().slice(0, 200) : null);
  const r = await storePool()!.query(
    `update scan_checks set verdict = $2, expected_name = $3, expected_set = $4, expected_number = $5,
       expected_catalog_id = $6, note = $7, judged_by = $8, judged_at = now()
     where check_id = $1 returning *`,
    [id, j.verdict, clean(j.name), clean(j.set), clean(j.number), clean(j.catalogId), clean(j.note), judge],
  );
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

/** A re-run's answer replaces the stored one; the verdict stays, because the
 *  card in the photo has not changed — only what the scanner says about it. */
export async function recordRerun(id: string, scanId: string, snapshot: ScanSnapshot): Promise<CheckRow | null> {
  if (!(await ensure())) return null;
  const r = await storePool()!.query(
    `update scan_checks set scan_id = $2, result = $3, runs = runs + 1, last_run_at = now()
     where check_id = $1 returning *`,
    [id, scanId, JSON.stringify(snapshot)],
  );
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

export async function listChecks(q: { limit?: number; offset?: number }): Promise<{
  checks: CheckRow[];
  total: number;
  summary: ReturnType<typeof summarize>;
}> {
  if (!(await ensure())) return { checks: [], total: 0, summary: summarize([]) };
  const pool = storePool()!;
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const [page, all] = await Promise.all([
    pool.query("select * from scan_checks order by created_at desc limit $1 offset $2", [limit, offset]),
    pool.query("select result, verdict from scan_checks"),
  ]);
  return {
    checks: page.rows.map(rowOf),
    total: all.rowCount ?? all.rows.length,
    summary: summarize(all.rows.map((r: any) => ({ result: r.result, verdict: isVerdict(r.verdict) ? r.verdict : null }))),
  };
}
