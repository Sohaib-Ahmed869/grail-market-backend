import { storePool } from "../cards.store.js";
import { COMMERCE_SCHEMA } from "./commerce.store.js";
import { CONDUCT_SCHEMA } from "./conduct.store.js";
import { PRICING_SCHEMA } from "./pricing.store.js";
import { MEMBERS_SCHEMA } from "./members.store.js";
import { SUPPORT_SCHEMA } from "./support.store.js";
import { roleOf, type Role } from "./roles.js";

// The staff record.
//
// It is a column on `users`, not a table of its own, because a member of staff
// IS a member — they have an account, they may have listings, and a second
// identity table would mean two rows to revoke instead of one. "Revoked in one
// click", from the feature set, is one UPDATE.
//
// The ALTER lives here rather than in `auth/store.ts` so this module owns its
// own schema and the auth module is not touched by a change that is not its
// concern. `initAdmin()` runs alongside the other init calls in main.ts.

export const ADMIN_SCHEMA = `
-- Which console role, if any, this account holds. 'member' is everybody else
-- and is the default, so an existing table gains the column closed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';

-- Who granted it and when, because "staff accounts: invite, scope, revoke" is
-- an audited action and a role that appeared from nowhere cannot be audited.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_granted_by text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_granted_at timestamptz;

-- Staff are a handful of rows in a table of members; the console reads them as
-- a set on every load of the team page.
CREATE INDEX IF NOT EXISTS users_staff ON users (role) WHERE role <> 'member';
`;

export async function initAdmin(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  // One call for everything the console owns: the staff role, the member
  // record's admin-only columns, the conduct board, the support desk, the
  // boost ledger and the price-engine exclusions.
  await pool.query(ADMIN_SCHEMA);
  await pool.query(MEMBERS_SCHEMA);
  await pool.query(CONDUCT_SCHEMA);
  await pool.query(SUPPORT_SCHEMA);
  await pool.query(COMMERCE_SCHEMA);
  await pool.query(PRICING_SCHEMA);
  await bootstrapOwner();
}

/**
 * The first owner.
 *
 * A console nobody can sign into is not secured, it is bricked — and the fix
 * people reach for is a hand-written UPDATE against production. `ADMIN_OWNERS`
 * is a comma-separated list of e-mail addresses that are promoted to owner at
 * boot if they are not already staff. It only ever grants owner to an account
 * that exists, never creates one, and never demotes anybody.
 */
async function bootstrapOwner(): Promise<void> {
  const raw = (process.env.ADMIN_OWNERS ?? "").trim();
  if (!raw) return;
  const pool = storePool();
  if (!pool) return;

  const emails = raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return;

  const r = await pool.query(
    `update users set role = 'owner', role_granted_by = 'ADMIN_OWNERS', role_granted_at = now()
      where lower(email) = any($1) and role = 'member'
      returning email`,
    [emails],
  );
  for (const row of r.rows) console.log(`[admin] ${row.email} promoted to owner via ADMIN_OWNERS`);

  // Say something when the list names nobody: a typo here is otherwise silent
  // and looks exactly like a working config until someone tries to sign in.
  const known = await pool.query(
    "select count(*)::int n from users where lower(email) = any($1)",
    [emails],
  );
  if (!known.rows[0]?.n) {
    console.warn(
      `[admin] ADMIN_OWNERS names ${emails.length} address(es), none of which has an account yet.`,
    );
  }
}

export type Staff = {
  userId: string;
  name: string;
  email: string;
  role: Role;
};

/**
 * The caller's staff record, or null if they hold no console role.
 *
 * Read per request rather than baked into the session token. A revoked role
 * has to take effect on the next request, not whenever the token happens to
 * expire — "revoked in one click" is not true if the click leaves a valid
 * session running for another day.
 */
export async function staffFor(userId: string): Promise<Staff | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    "select user_id, name, email, role from users where user_id = $1",
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const role = roleOf(row.role);
  if (role === "member") return null;
  return { userId: row.user_id, name: row.name, email: row.email, role };
}

/** Everyone who holds a console role. The team page. */
export async function staffList(): Promise<(Staff & { grantedAt: string | null })[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select user_id, name, email, role, role_granted_at
       from users where role <> 'member' order by role, name`,
  );
  return r.rows.map((x: any) => ({
    userId: x.user_id,
    name: x.name,
    email: x.email,
    role: roleOf(x.role),
    grantedAt: x.role_granted_at ? new Date(x.role_granted_at).toISOString() : null,
  }));
}

/** Invite, scope, revoke — all three are this one write. */
export async function setRole(
  userId: string,
  role: Role,
  by: string,
): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    `update users set role = $2, role_granted_by = $3, role_granted_at = now()
      where user_id = $1`,
    [userId, role, by],
  );
  return (r.rowCount ?? 0) > 0;
}
