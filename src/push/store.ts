import { storePool } from "../cards.store.js";

// Where to send a notification.
//
// One person can have several devices and a device can be reassigned to
// another account, so the token is the key and the user is a column — the
// other way round loses a device the moment someone signs in on a friend's
// phone, and worse, keeps sending that friend their alerts.

export const PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_tokens (
  token      text PRIMARY KEY,
  user_id    text NOT NULL,
  platform   text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_user ON push_tokens (user_id);
`;

export async function initPush(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(PUSH_SCHEMA);
}

export async function registerToken(
  token: string, userId: string, platform: string | null,
): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(
    `insert into push_tokens (token, user_id, platform) values ($1,$2,$3)
     on conflict (token) do update set user_id = $2, platform = $3, updated_at = now()`,
    [token, userId, platform],
  );
}

export async function forgetToken(token: string): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query("delete from push_tokens where token = $1", [token]);
}

export async function tokensFor(userId: string): Promise<string[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query("select token from push_tokens where user_id = $1", [userId]);
  return r.rows.map((x: any) => x.token);
}
