/**
 * Find a listing that's claimed in review and release it to awaiting status.
 *
 *   npx tsx scripts/release-for-review.mts
 *
 * Finds a listing currently in_review with claimed_by set, and releases it
 * to awaiting review (clears claimed_by so it shows as "awaiting").
 */
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const { storeConfigured, storePool } = await import("../src/cards.store.js");

if (!storeConfigured()) {
  console.error("DATABASE_URL is not set — nothing to change.");
  process.exit(1);
}

const pool = storePool()!;

// Find a listing that's in_review and currently claimed
const found = await pool.query(
  `select listing_id, card_name, set_name, grader, grade, status, price, claimed_by,
          u.name as seller
     from listings l
     join users u on u.user_id = l.seller_id
    where l.status = 'in_review' and l.claimed_by is not null
    limit 1`,
);

if (found.rows.length === 0) {
  console.log("No claimed listings in review found.");

  // Try to find one in info_requested that we can move to in_review
  const found2 = await pool.query(
    `select listing_id, card_name, set_name, grader, grade, status, price,
            u.name as seller
       from listings l
       join users u on u.user_id = l.seller_id
      where l.status = 'info_requested'
      limit 1`,
  );

  if (found2.rows.length === 0) {
    console.log("No listings found that can be moved to awaiting review.");
    await pool.end();
    process.exit(1);
  }

  const l = found2.rows[0];
  console.log(
    `\nFound info_requested listing:\n  ${l.card_name} · ${l.grader} ${l.grade} · ${l.set_name}` +
      `\n  ${l.seller} · $${Number(l.price).toLocaleString("en-AU")}\n`,
  );

  // Move to in_review with no claim
  await pool.query(
    `update listings
        set status = 'in_review',
            reject_reason = null,
            submitted_at = now(),
            claimed_by = null,
            claimed_at = null
      where listing_id = $1`,
    [l.listing_id],
  );

  console.log(`✓ Moved to awaiting review queue\n`);
} else {
  const l = found.rows[0];
  console.log(
    `\nFound in_review claimed listing:\n  ${l.card_name} · ${l.grader} ${l.grade} · ${l.set_name}` +
      `\n  ${l.seller} · $${Number(l.price).toLocaleString("en-AU")}` +
      `\n  Currently claimed by: ${l.claimed_by}\n`,
  );

  // Release it (clear claimed_by)
  await pool.query(
    `update listings
        set claimed_by = null, claimed_at = null
      where listing_id = $1`,
    [l.listing_id],
  );

  console.log(`✓ Released to awaiting review queue\n`);
}

await pool.end();
process.exit(0);
