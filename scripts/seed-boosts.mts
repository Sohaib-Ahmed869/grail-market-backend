/**
 * Boosts, for working on the subscriptions page.
 *
 *   npx tsx scripts/seed-boosts.mts
 *
 * A boost is a one-off charge against one listing. The app has no purchase
 * flow for one yet, so nothing writes `listing_boosts` in normal running and
 * the ledger is empty — which is honest, and also impossible to work on.
 *
 * Two of these are deliberately left in the state the feature set calls out by
 * name: paid for and never applied. That is the only row on the page with work
 * in it, and it is the one the console has to be able to fix.
 *
 * Re-running it adds another set rather than editing the first.
 */
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const { storeConfigured, storePool } = await import("../src/cards.store.js");
const { initCommerce, BOOST_TIERS } = await import("../src/admin/commerce.store.js");

if (!storeConfigured()) {
  console.error("DATABASE_URL is not set — nothing to seed.");
  process.exit(1);
}

await initCommerce();
const pool = storePool()!;

/** Live or sold listings, which are the only ones anybody would boost. */
const listings = await pool.query(
  `select listing_id, seller_id, card_name from listings
    where status in ('live','sold') order by created_at limit 6`,
);

if (!listings.rowCount) {
  console.error("No live listing to boost. Run scripts/seed-queue.mts first.");
  process.exit(1);
}

type Seed = {
  tier: "day" | "week" | "month";
  boughtHoursAgo: number;
  /** Null leaves it paid and never applied — the state worth a queue. */
  appliedHoursAgo: number | null;
  fault?: string;
};

const SEEDS: Seed[] = [
  {
    tier: "week",
    boughtHoursAgo: 148,
    appliedHoursAgo: null,
    fault:
      "The listing was pulled into review two minutes after the charge cleared, and the scheduler skips anything not live. It never retried once the listing went back up.",
  },
  {
    tier: "day",
    boughtHoursAgo: 34,
    appliedHoursAgo: null,
    fault:
      "Card declined on the retry after an initial authorisation. The charge settled; the boost did not start.",
  },
  { tier: "month", boughtHoursAgo: 480, appliedHoursAgo: 479 },
  { tier: "week", boughtHoursAgo: 120, appliedHoursAgo: 119 },
  { tier: "day", boughtHoursAgo: 340, appliedHoursAgo: 339 },
];

let n = 0;
for (const [i, s] of SEEDS.entries()) {
  const l = listings.rows[i % listings.rowCount];
  const t = BOOST_TIERS.find((x) => x.key === s.tier)!;
  const bought = new Date(Date.now() - s.boughtHoursAgo * 3_600_000);
  const applied =
    s.appliedHoursAgo === null ? null : new Date(Date.now() - s.appliedHoursAgo * 3_600_000);
  const expires = applied ? new Date(applied.getTime() + t.days * 86_400_000) : null;

  await pool.query(
    `insert into listing_boosts
       (boost_id, listing_id, user_id, tier, amount_cents, currency,
        purchased_at, applied_at, expires_at, fault)
     values ($1,$2,$3,$4,$5,'AUD',$6,$7,$8,$9)`,
    [
      `bs_${randomUUID().slice(0, 12)}`,
      l.listing_id,
      l.seller_id,
      t.key,
      t.amountCents,
      bought,
      applied,
      expires,
      s.fault ?? null,
    ],
  );
  n += 1;
  console.log(`${t.name} on ${l.card_name} — ${applied ? "applied" : "PAID, NEVER APPLIED"}`);
}

console.log(`\n${n} boosts written.`);
await pool.end();
