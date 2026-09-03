import { storePool } from "../cards.store.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { newUserId } from "./tokens.js";
import { hashToken, newResetToken, RESET_TTL_MS, type ResetRow } from "./reset.js";

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

-- Two-step verification. The secret is the credential, so it is only ever
-- written once and never returned after enrolment is confirmed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false;
-- Recovery codes, hashed, one row's worth as a json array of digests. A used
-- code is removed from the array rather than flagged, so there is no way to
-- present a spent code and have it counted.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recovery jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;

-- Reset links. Only the digest is stored; see auth/reset.ts.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets (user_id);
`;

export async function initAuth(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(AUTH_SCHEMA);
}

export type User = {
  user_id: string; email: string; name: string; phone: string | null;
  avatar?: string | null; mfa_enabled?: boolean;
};

/** Emails are matched lowercase but stored as typed.
 *
 *  Nobody thinks of Alex@ and alex@ as two accounts, and letting them be two
 *  is how a person ends up unable to sign in to the account they made. */
export async function findByEmail(
  email: string,
): Promise<(User & { password: string; mfa_secret: string | null; mfa_recovery: string[] | null }) | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select user_id, email, name, phone, password, avatar,
            coalesce(mfa_enabled, false) as mfa_enabled, mfa_secret, mfa_recovery
       from users where lower(email) = lower($1)`,
    [email],
  );
  return r.rows[0] ?? null;
}

export async function findById(userId: string): Promise<User | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select user_id, email, name, phone, avatar, coalesce(mfa_enabled, false) as mfa_enabled
       from users where user_id = $1`,
    [userId],
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
  // Pick the fields out rather than spreading and deleting. A spread returns
  // whatever the query happened to select, so the day someone adds a column
  // it ships to the client — which is exactly how mfa_secret nearly did.
  return {
    ok: true,
    user: {
      user_id: row.user_id, email: row.email, name: row.name,
      phone: row.phone, avatar: row.avatar ?? null, mfa_enabled: row.mfa_enabled,
    },
  };
}

// ---- resetting a forgotten password ----------------------------------------

/** Issue a link. Any earlier live link for the same account is spent first, so
 *  requesting twice does not leave two working doors open. */
export async function createReset(userId: string): Promise<{ token: string } | null> {
  const pool = storePool();
  if (!pool) return null;
  const { token, hash } = newResetToken();
  await pool.query(
    "update password_resets set used_at = now() where user_id = $1 and used_at is null",
    [userId],
  );
  await pool.query(
    `insert into password_resets (token_hash, user_id, expires_at)
     values ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
    [hash, userId, String(RESET_TTL_MS)],
  );
  return { token };
}

export async function findReset(token: string): Promise<
  ({ user_id: string } & ResetRow) | null
> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    "select token_hash, user_id, expires_at, used_at from password_resets where token_hash = $1",
    [hashToken(token)],
  );
  return r.rows[0] ?? null;
}

/** Spend the link and set the password in one transaction.
 *
 *  Separately they can interleave: two tabs submitting the same link would
 *  both read it unused and both set a password, and the second one wins with
 *  no record that the first happened. */
export async function consumeReset(
  token: string, newPassword: string,
): Promise<{ ok: true; userId: string } | { ok: false }> {
  const pool = storePool();
  if (!pool) return { ok: false };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const r = await client.query(
      `select user_id from password_resets
        where token_hash = $1 and used_at is null and expires_at > now()
        for update`,
      [hashToken(token)],
    );
    const userId = r.rows[0]?.user_id;
    if (!userId) { await client.query("rollback"); return { ok: false }; }
    await client.query("update password_resets set used_at = now() where token_hash = $1", [
      hashToken(token),
    ]);
    await client.query(
      "update users set password = $2, password_changed_at = now() where user_id = $1",
      [userId, await hashPassword(newPassword)],
    );
    await client.query("commit");
    return { ok: true, userId };
  } catch {
    await client.query("rollback").catch(() => {});
    return { ok: false };
  } finally {
    client.release();
  }
}

// ---- account settings ------------------------------------------------------

/** Changing a password requires the current one, even though the caller is
 *  already authenticated. A borrowed unlocked phone should not be enough to
 *  lock the owner out of their own account. */
export async function changePassword(
  userId: string, current: string, next: string,
): Promise<{ ok: true } | { ok: false; why: "wrong-password" | "weak" | "no-store" }> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "no-store" };
  if (String(next ?? "").length < 10) return { ok: false, why: "weak" };
  const r = await pool.query("select password from users where user_id = $1", [userId]);
  const stored = r.rows[0]?.password ?? "x:0000";
  if (!(await verifyPassword(current, stored))) return { ok: false, why: "wrong-password" };
  await pool.query(
    "update users set password = $2, password_changed_at = now() where user_id = $1",
    [userId, await hashPassword(next)],
  );
  return { ok: true };
}

/** Name and phone only.
 *
 *  Email is deliberately absent: changing the address on an account is an
 *  account takeover primitive, and doing it properly means confirming the new
 *  address before it takes effect. Until that exists, it is not offered. */
export async function updateProfile(
  userId: string, patch: { name?: string; phone?: string | null },
): Promise<User | null> {
  const pool = storePool();
  if (!pool) return null;
  const sets: string[] = [];
  const args: any[] = [userId];
  if (patch.name != null) {
    const name = patch.name.trim();
    if (name.length < 2) return null;
    args.push(name.slice(0, 60));
    sets.push(`name = $${args.length}`);
  }
  if (patch.phone !== undefined) {
    args.push(patch.phone ? patch.phone.trim().slice(0, 20) : null);
    sets.push(`phone = $${args.length}`);
  }
  if (!sets.length) return findById(userId);
  await pool.query(`update users set ${sets.join(", ")} where user_id = $1`, args);
  return findById(userId);
}

// ---- two-step verification -------------------------------------------------

/** Stage a secret without turning anything on.
 *
 *  Enrolment is two steps because a one-step version locks people out: they
 *  scan a code, we flip the flag, and then their authenticator turns out to be
 *  on a phone with the wrong time. The flag only moves once they have proved
 *  the app is producing codes we accept. */
export async function stageMfa(userId: string, secret: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    "update users set mfa_secret = $2 where user_id = $1 and coalesce(mfa_enabled, false) = false",
    [userId, secret],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function pendingMfaSecret(userId: string): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    "select mfa_secret from users where user_id = $1 and coalesce(mfa_enabled, false) = false",
    [userId],
  );
  return r.rows[0]?.mfa_secret ?? null;
}

export async function enableMfa(userId: string, recoveryHashes: string[]): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    "update users set mfa_enabled = true, mfa_recovery = $2 where user_id = $1 and mfa_secret is not null",
    [userId, JSON.stringify(recoveryHashes)],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Turning it off clears the secret and the codes. Leaving a stale secret in
 *  the row means re-enabling silently reuses a secret the user may have shared
 *  with a device they no longer have. */
export async function disableMfa(userId: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    `update users set mfa_enabled = false, mfa_secret = null, mfa_recovery = null
      where user_id = $1`,
    [userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Spend a recovery code by removing its digest from the array. */
export async function spendRecoveryCode(userId: string, digest: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query("select mfa_recovery from users where user_id = $1", [userId]);
  const codes: string[] = r.rows[0]?.mfa_recovery ?? [];
  if (!codes.includes(digest)) return false;
  await pool.query("update users set mfa_recovery = $2 where user_id = $1", [
    userId, JSON.stringify(codes.filter((c) => c !== digest)),
  ]);
  return true;
}
