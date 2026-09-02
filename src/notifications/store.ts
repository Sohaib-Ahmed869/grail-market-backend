import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";

// What happened while you were away.
//
// A push notification is a tap you either caught or missed; this is the
// record. Everything that would push also lands here, plus the things not
// worth interrupting someone for — a listing approved, a rating left. The
// bell is therefore always worth opening, which is the only way a bell earns
// its place in a header.
//
// Each row carries where to go, so tapping one lands on the thing itself
// rather than on a list about the thing.

export const NOTIFICATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS notifications (
  notification_id text PRIMARY KEY,
  user_id    text NOT NULL,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text,
  /** deep link target, e.g. /listing/l_x or /messages/t_x */
  href       text,
  /** the actor, when there is one, for an avatar on the row */
  actor_id   text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user
  ON notifications (user_id, created_at DESC);
`;

export async function initNotifications(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(NOTIFICATIONS_SCHEMA);
}

export type Kind =
  | "offer" | "offer-settled" | "message" | "listing" | "rating" | "price";

export async function notify(n: {
  userId: string; kind: Kind; title: string;
  body?: string | null; href?: string | null; actorId?: string | null;
}): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  // Never let a notification failure take down the thing it is describing.
  try {
    await pool.query(
      `insert into notifications (notification_id, user_id, kind, title, body, href, actor_id)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [`n_${randomUUID().slice(0, 12)}`, n.userId, n.kind, n.title,
       n.body ?? null, n.href ?? null, n.actorId ?? null],
    );
  } catch {
    // deliberately swallowed
  }
}

export async function listFor(userId: string, limit = 50): Promise<any[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select n.*, u.name as actor_name, u.avatar as actor_avatar
       from notifications n
       left join users u on u.user_id = n.actor_id
      where n.user_id = $1
      order by n.created_at desc
      limit $2`,
    [userId, limit],
  );
  return r.rows;
}

export async function unreadCount(userId: string): Promise<number> {
  const pool = storePool();
  if (!pool) return 0;
  const r = await pool.query(
    "select count(*)::int n from notifications where user_id = $1 and read_at is null",
    [userId]);
  return r.rows[0]?.n ?? 0;
}

export async function markAllRead(userId: string): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(
    "update notifications set read_at = now() where user_id = $1 and read_at is null",
    [userId]);
}
