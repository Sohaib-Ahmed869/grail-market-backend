import { storePool } from "../cards.store.js";
import type { DiditStatus } from "./didit.js";

// Where a member stands with identity, and every decision we were told about.
//
// Two tables on purpose. `identity_status` is the answer to "can this person
// trade", read on every gated action and holding exactly one row per member.
// `identity_events` is append-only history — what Didit said, when, and under
// which session. Invariant 5 of CLAUDE.md applies here as much as to sales:
// never UPDATE a decision, write another one.

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
  decision   jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_events_user ON identity_events (user_id, received_at DESC);
`;

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

export async function recordEvent(e: {
  eventId: string; userId: string; sessionId: string | null;
  status: DiditStatus; decision: unknown;
}): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(
    `insert into identity_events (event_id, user_id, session_id, status, decision)
     values ($1,$2,$3,$4,$5) on conflict (event_id) do nothing`,
    [e.eventId, e.userId, e.sessionId, e.status, e.decision ? JSON.stringify(e.decision) : null],
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
