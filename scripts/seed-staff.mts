/**
 * One console account per role, for working the CMS.
 *
 *   npx tsx scripts/seed-staff.mts
 *
 * The console has five roles and the scoping is the whole point of them — a
 * Tier 1 agent seeing a Trust and safety ticket is the failure the roles table
 * exists to prevent. With one owner account on the database there is nothing
 * to check that against, and "view the console as" only changes what is drawn,
 * not what the API answers.
 *
 * Named for the role rather than for a person. These are not colleagues, they
 * are seats: a real deployment grants a role to somebody who has signed up,
 * and inventing four plausible-looking names is how the audit log ends up
 * listing people who do not exist — which is exactly what happened.
 *
 * Owner is deliberately not created. There is one already, it is the account
 * you use, and a second owner nobody asked for is a second key to everything.
 *
 * Re-running it is safe: an account that already exists keeps its password and
 * has only its role reasserted.
 */
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const { storeConfigured, storePool } = await import("../src/cards.store.js");
const { initAdmin } = await import("../src/admin/store.js");
const { createUser } = await import("../src/auth/store.js");

if (!storeConfigured()) {
  console.error("DATABASE_URL is not set — nothing to seed.");
  process.exit(1);
}

await initAdmin();
const pool = storePool()!;

/** The password every seeded account gets. Development only — these are seats
 *  on a local database, not credentials for anything that ships. */
const PASSWORD = process.env.SEED_STAFF_PASSWORD ?? "grailmarket-dev-2026";

const SEATS: { name: string; email: string; role: string }[] = [
  { name: "Moderator", email: "moderator@grailmarket.test", role: "moderator" },
  { name: "Support Tier 1", email: "tier1@grailmarket.test", role: "tier-1" },
  { name: "Support Tier 2", email: "tier2@grailmarket.test", role: "tier-2" },
  { name: "Trust & Safety", email: "trust@grailmarket.test", role: "trust-safety" },
];

for (const seat of SEATS) {
  const existing = await pool.query("select user_id, role from users where lower(email) = $1", [
    seat.email,
  ]);

  let userId: string | undefined = existing.rows[0]?.user_id;

  if (!userId) {
    const made = await createUser({
      email: seat.email,
      name: seat.name,
      phone: null,
      password: PASSWORD,
    });
    if (!made.ok) {
      console.error(`  ! ${seat.name} — ${made.why}`);
      continue;
    }
    userId = made.user.user_id;
  }

  await pool.query(
    `update users set role = $2, role_granted_by = 'seed-staff', role_granted_at = now()
      where user_id = $1`,
    [userId, seat.role],
  );
  console.log(`  · ${seat.name.padEnd(16)} ${seat.email.padEnd(28)} ${seat.role}`);
}

const team = await pool.query(
  "select name, email, role from users where role <> 'member' order by role, name",
);
console.log(`\nThe console team is now ${team.rowCount} account(s):`);
for (const r of team.rows) console.log(`  ${r.role.padEnd(14)} ${r.name} · ${r.email}`);
console.log(`\nPassword for the seeded seats: ${PASSWORD}`);
process.exit(0);
