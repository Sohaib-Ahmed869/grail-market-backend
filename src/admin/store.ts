import { storePool } from "../cards.store.js";
import { ANNOUNCE_SCHEMA } from "./announce.store.js";
import { AUDIT_SCHEMA } from "./audit.store.js";
import { SETTINGS_SCHEMA } from "./settings.store.js";
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

/**
 * Indexes for the console's own read patterns.
 *
 * They live here rather than beside each table because they exist for the
 * admin queries specifically: the app asks `listings` "what is this seller
 * selling", the console asks it "what was decided between these two dates",
 * and those want different indexes over the same rows. Adding them to the
 * owning module would look arbitrary there.
 *
 * What each one is for:
 *
 *   - `/admin/reports` bounds every one of its aggregates on a date range over
 *     `reviewed_at`, `sold_at`, `created_at` or `decided_at`, and not one of
 *     those columns was indexed. Every panel on that page was a sequential
 *     scan of the whole table, and there are fourteen of them per load.
 *   - The listing queue and the member directory both compute per-row seller
 *     statistics with correlated subqueries. Those are cheap when the column
 *     they correlate on is indexed and quadratic when it is not.
 *
 * Partial indexes where the query always carries the same predicate: an index
 * over sold listings is a fraction of the size of one over all of them, and
 * the console never asks about the rest.
 */
export const ADMIN_INDEXES = `
-- reports: GMV, the game split and seller concentration, all bounded on sold_at
CREATE INDEX IF NOT EXISTS listings_sold_at
  ON listings (sold_at DESC) WHERE status = 'sold';

-- reports: throughput, the decision split, time-to-decision and the
-- low-confidence audit, all bounded on reviewed_at
CREATE INDEX IF NOT EXISTS listings_reviewed_at
  ON listings (reviewed_at DESC) WHERE reviewed_at IS NOT NULL;

-- reports: member growth, and the running total it is drawn from
CREATE INDEX IF NOT EXISTS users_created_at ON users (created_at);

-- reports: conflict outcomes and conduct actions
CREATE INDEX IF NOT EXISTS conduct_decided_at
  ON conduct_cases (decided_at DESC) WHERE decided_at IS NOT NULL;

-- reports: tickets opened in the period
CREATE INDEX IF NOT EXISTS support_created_at ON support_tickets (created_at DESC);

-- the member directory counts a member's strikes per row, and this join had
-- no index at all: conduct_cases was scanned once per member on screen
CREATE INDEX IF NOT EXISTS conduct_against ON conduct_cases (against_id)
  WHERE outcome IS NOT NULL AND outcome <> 'none';

-- the listing queue and the directory both count a seller's completed sales
CREATE INDEX IF NOT EXISTS listings_seller_sold
  ON listings (seller_id) WHERE status = 'sold';

-- and both average the reviews they were left. ratings_ratee is ordered by
-- date for the profile feed; this one carries the role the console filters on
-- and the stars it averages, so the average is read from the index alone.
CREATE INDEX IF NOT EXISTS ratings_ratee_role
  ON ratings (ratee_id, rater_role) INCLUDE (stars);

-- the directory counts accepted offers per member
CREATE INDEX IF NOT EXISTS offers_buyer_accepted
  ON offers (buyer_id) WHERE status = 'accepted';

-- the queue orders by submission time within a status on every load
CREATE INDEX IF NOT EXISTS listings_queue_order
  ON listings (submitted_at) WHERE status = 'in_review';
`;

export async function initAdmin(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  // One call for everything the console owns: the staff role, the member
  // record's admin-only columns, the conduct board, the support desk, the
  // boost ledger, the price-engine exclusions, the audit log and the
  // announcement queue.
  await pool.query(ADMIN_SCHEMA);
  await pool.query(MEMBERS_SCHEMA);
  await pool.query(CONDUCT_SCHEMA);
  await pool.query(SUPPORT_SCHEMA);
  await pool.query(COMMERCE_SCHEMA);
  await pool.query(PRICING_SCHEMA);
  await pool.query(AUDIT_SCHEMA);
  await pool.query(ANNOUNCE_SCHEMA);
  await pool.query(SETTINGS_SCHEMA);
  /* Last, and separately: these index tables the blocks above have just
     created, and one that fails must not take the schema with it. An index is
     a speed-up, not a correctness requirement — a console that will not boot
     because `INCLUDE` needs a newer Postgres than this one is a worse outcome
     than a console that is slow. */
  await pool.query(ADMIN_INDEXES).catch((e) => {
    console.warn("[admin] some indexes were not created:", (e as Error).message);
  });
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

/**
 * Find an account to give a role to, by address.
 *
 * Deliberately not `findByEmail` from the auth store: that returns the
 * password hash and the MFA secret alongside the name, and the admin
 * controller has no business holding either. Three columns is what granting a
 * role needs.
 */
export async function userByEmail(
  email: string,
): Promise<{ userId: string; name: string; role: Role } | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    "select user_id, name, role from users where lower(email) = lower($1)",
    [email],
  );
  const row = r.rows[0];
  return row ? { userId: row.user_id, name: row.name, role: roleOf(row.role) } : null;
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
