import { storePool } from "../cards.store.js";
import { TtlCache } from "../scans/ttlcache.js";
import type { Kind } from "./store.js";

// What somebody has asked NOT to be interrupted about.
//
// Stored as the set of muted kinds rather than the set of allowed ones, so the
// default is whatever `PUSHES` in store.ts says and a kind added later starts
// on for everybody instead of silently off for every existing member. A row
// only exists once somebody has changed something.
//
// One row per member, not one per member per kind: the whole preference is
// read together on every push, and five rows to answer one question is four
// round trips nobody needed.

export const NOTIFICATION_PREFS_SCHEMA = `
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id    text PRIMARY KEY,
  muted      text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export async function initNotificationPrefs(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(NOTIFICATION_PREFS_SCHEMA);
}

/** Read on the push path, which runs for every offer, message and alert. Ten
 *  minutes is short enough that turning something off feels immediate and long
 *  enough that a busy thread does not re-ask per message. */
const cache = new TtlCache<string[]>(10 * 60 * 1000, 2000);

export async function mutedFor(userId: string): Promise<string[]> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const pool = storePool();
  if (!pool) return [];
  try {
    const r = await pool.query(
      "select muted from notification_prefs where user_id = $1", [userId],
    );
    const muted = (r.rows[0]?.muted as string[] | undefined) ?? [];
    cache.set(userId, muted);
    return muted;
  } catch {
    // A preference we cannot read is not a preference to mute. Failing open
    // sends a notification somebody may not have wanted; failing closed loses
    // an offer on their card.
    return [];
  }
}

export async function setMuted(
  userId: string, kind: Kind, muted: boolean,
): Promise<string[]> {
  const pool = storePool();
  if (!pool) return [];
  const current = new Set(await mutedFor(userId));
  if (muted) current.add(kind);
  else current.delete(kind);
  const next = [...current];

  await pool.query(
    `insert into notification_prefs (user_id, muted) values ($1, $2)
     on conflict (user_id) do update set muted = $2, updated_at = now()`,
    [userId, next],
  );
  cache.set(userId, next);
  return next;
}
