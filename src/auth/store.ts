import { storePool } from "../cards.store.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { newUserId } from "./tokens.js";

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id     text PRIMARY KEY,
  email       text UNIQUE NOT NULL,
  name        text NOT NULL,
  phone       text,
  password    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_email ON users (lower(email));

-- A face to put on a post. One of a fixed set the app draws, so this is a
-- key like "charizard", never a URL and never an upload — nothing here can
-- become a place to host an image we did not choose.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text;
`;

export async function initAuth(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(AUTH_SCHEMA);
}

export type User = { user_id: string; email: string; name: string; phone: string | null };

/** Emails are matched lowercase but stored as typed.
 *
 *  Nobody thinks of Alex@ and alex@ as two accounts, and letting them be two
 *  is how a person ends up unable to sign in to the account they made. */
export async function findByEmail(email: string): Promise<(User & { password: string }) | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    "select user_id, email, name, phone, password from users where lower(email) = lower($1)",
    [email],
  );
  return r.rows[0] ?? null;
}

export async function findById(userId: string): Promise<User | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    "select user_id, email, name, phone, avatar from users where user_id = $1", [userId],
  );
  return r.rows[0] ?? null;
}

/** Set the picture. Validated against the app's own list by the caller, and
 *  length-capped here so a bad client cannot write an essay into the column. */
export async function setAvatar(userId: string, avatar: string | null): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    "update users set avatar = $2 where user_id = $1",
    [userId, avatar ? avatar.slice(0, 40) : null],
  );
  return (r.rowCount ?? 0) > 0;
}

export type CreateResult =
  | { ok: true; user: User }
  | { ok: false; why: "email-taken" | "no-store" };

export async function createUser(u: {
  email: string; name: string; phone: string | null; password: string;
}): Promise<CreateResult> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "no-store" };
  if (await findByEmail(u.email)) return { ok: false, why: "email-taken" };

  const user_id = newUserId();
  await pool.query(
    `insert into users (user_id, email, name, phone, password) values ($1,$2,$3,$4,$5)`,
    [user_id, u.email.trim(), u.name.trim(), u.phone, await hashPassword(u.password)],
  );
  return { ok: true, user: { user_id, email: u.email.trim(), name: u.name.trim(), phone: u.phone } };
}

export type SignInResult = { ok: true; user: User } | { ok: false };

/** Wrong email and wrong password fail identically.
 *
 *  Distinguishing them turns the login form into a tool for discovering which
 *  addresses hold accounts. The work is still done on a miss so the two paths
 *  take a similar time. */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const row = await findByEmail(email);
  const stored = row?.password ?? "x:0000";
  const good = await verifyPassword(password, stored);
  if (!row || !good) return { ok: false };
  const { password: _p, ...user } = row;
  return { ok: true, user };
}
