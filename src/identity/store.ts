import { storePool } from "../cards.store.js";
import type { DiditStatus } from "./didit.js";

// Where a member stands with identity, and the outcome of each check.
//
// Two tables on purpose. `identity_status` is the answer to "can this person
// trade", read on every gated action and holding exactly one row per member.
// `identity_events` is history — which session, what status, when, and the
// risk codes Didit raised. Never UPDATE an outcome, write another one.
//
// WHAT WE DO NOT KEEP, and why this file used to be wrong about it. The
// client's position, set on 31 August and repeated firmly on breach-exposure
// grounds: identity documents are never retained on the GrailMarket database.
// Didit's webhook `decision` IS the document — full name, date of birth,
// document number, address, links to the front, back and portrait images, the
// face match, the IP analysis, contact details. This table stored all of it
// as jsonb, and nothing anywhere ever read it back. It was pure liability.
//
// Now only the status and Didit's risk codes are kept: DUPLICATED_IP_ADDRESS,
// DEVICE_EMULATOR_DETECTED and the like. They answer the one question support
// will actually be asked — "why was I declined" — and none of them is
// personal. Didit holds the document for as long as its own retention setting
// says; we hold the verdict.

export const IDENTITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS identity_status (
  user_id      text PRIMARY KEY,
  status       text NOT NULL,
  session_id   text,
  verified_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS identity_events (
  event_id   text PRIMARY KEY,
  user_id    text NOT NULL,
  session_id text,
  status     text NOT NULL,
  reasons    text[],
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_events_user ON identity_events (user_id, received_at DESC);
ALTER TABLE identity_events ADD COLUMN IF NOT EXISTS reasons text[];
-- Purge what earlier builds stored. The risk codes are lifted out of each
-- old decision first so no history of WHY is lost, then the value is nulled
-- and the column dropped. Idempotent: once the column is gone this is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'identity_events' AND column_name = 'decision') THEN
    UPDATE identity_events e SET reasons = (
      SELECT array_agg(DISTINCT c ORDER BY c) FROM (
        SELECT w->>'risk' AS c
        FROM jsonb_path_query(e.decision, 'strict $.**.warnings[*]') AS w
      ) x WHERE c ~ '^[A-Z0-9_]{3,64}$'
    )
    WHERE e.decision IS NOT NULL AND e.reasons IS NULL;
    UPDATE identity_events SET decision = NULL WHERE decision IS NOT NULL;
    ALTER TABLE identity_events DROP COLUMN IF EXISTS decision;
  END IF;
END $$;
`;

/** Didit's risk codes from a decision, and nothing else from it.
 *
 *  A code is kept only if it looks like one — capitals, digits, underscores.
 *  Anything else under a `risk` key is dropped rather than stored verbatim,
 *  so a provider that one day puts a name there cannot smuggle it in. */
export function riskCodesFrom(decision: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "warnings" && Array.isArray(x)) {
        for (const w of x) {
          const risk = (w as { risk?: unknown } | null)?.risk;
          if (typeof risk === "string" && /^[A-Z0-9_]{3,64}$/.test(risk)) out.add(risk);
        }
      } else {
        walk(x, depth + 1);
      }
    }
  };
  walk(decision, 0);
  return [...out].sort().slice(0, 20);
}

export async function initIdentity(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(IDENTITY_SCHEMA);
}

/** Has this delivery already been applied?
 *
 *  Didit retries twice on a 5xx, and a retry carries the same event_id. Without
 *  this a slow response would apply the same decision three times — harmless
 *  for a status, not harmless for the event log or anything hung off it. */
export async function alreadySeen(eventId: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query("select 1 from identity_events where event_id = $1", [eventId]);
  return (r.rowCount ?? 0) > 0;
}

/** One outcome. Takes the risk codes, not the decision — the decision never
 *  reaches this function, so it cannot reach the database by accident. */
export async function recordEvent(e: {
  eventId: string; userId: string; sessionId: string | null;
  status: DiditStatus; reasons: string[];
}): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(
    `insert into identity_events (event_id, user_id, session_id, status, reasons)
     values ($1,$2,$3,$4,$5) on conflict (event_id) do nothing`,
    [e.eventId, e.userId, e.sessionId, e.status, e.reasons.length ? e.reasons : null],
  );
}

/** The one row that answers "can this person trade".
 *
 *  Only Approved sets verified_at, and it is never cleared by a later
 *  In Progress — a member who starts a second verification has not stopped
 *  being verified. Kyc Expired is the one status that takes it away. */
export async function applyStatus(
  userId: string, status: DiditStatus, sessionId: string | null,
): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  const verified = status === "Approved";
  const expired = status === "Kyc Expired";
  await pool.query(
    `insert into identity_status (user_id, status, session_id, verified_at, updated_at)
     values ($1,$2,$3, case when $4 then now() else null end, now())
     on conflict (user_id) do update set
       status = excluded.status,
       session_id = coalesce(excluded.session_id, identity_status.session_id),
       verified_at = case
         when $4 then now()
         when $5 then null
         else identity_status.verified_at end,
       updated_at = now()`,
    [userId, status, sessionId, verified, expired],
  );
}

export async function readStatus(userId: string) {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    "select user_id, status, verified_at from identity_status where user_id = $1",
    [userId],
  );
  return r.rows[0] ?? null;
}
