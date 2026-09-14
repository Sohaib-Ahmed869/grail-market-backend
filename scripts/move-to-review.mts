/**
 * Move a listing back to in_review status.
 *
 *   npx tsx scripts/move-to-review.mts l_57f89386-5e9
 *
 * Updates a listing to "in_review" status so it appears in the verification
 * queue. Valid source statuses are info_requested and rejected (with caveats).
 */
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const { storeConfigured, storePool } = await import("../src/cards.store.js");
const { writeAudit } = await import("../src/admin/audit.store.js");

const id = process.argv[2]?.trim();
const reason = process.argv.slice(3).join(" ").trim();

if (!id) {
  console.error("Usage: npx tsx scripts/move-to-review.mts <listing-id> [reason]");
  process.exit(1);
}

if (!storeConfigured()) {
  console.error("DATABASE_URL is not set — nothing to change.");
  process.exit(1);
}

const pool = storePool()!;

const found = await pool.query(
  `select l.listing_id, l.card_name, l.set_name, l.grader, l.grade, l.status, l.price,
          u.name as seller
     from listings l join users u on u.user_id = l.seller_id
    where l.listing_id = $1`,
  [id],
);

const l = found.rows[0];
if (!l) {
  console.error(`No listing ${id}. Nothing changed.`);
  await pool.end();
  process.exit(1);
}

console.log(
  `\n  ${l.card_name} · ${l.grader} ${l.grade} · ${l.set_name}` +
    `\n  ${l.seller} · $${Number(l.price).toLocaleString("en-AU")} · currently ${l.status}\n`,
);

/* Valid transitions to in_review:
   - info_requested -> in_review (seller answered a request for more info)
   - rejected -> in_review (resubmitting after rejection, though this is unusual)
*/
const validTransitions = ["info_requested", "rejected"];
if (!validTransitions.includes(l.status)) {
  console.error(
    `Can only move to review from info_requested or rejected. This one is ${l.status}. Nothing changed.`,
  );
  await pool.end();
  process.exit(1);
}

/* Update the listing status to in_review. The submitted_at timestamp is
   refreshed so it starts a new review cycle. */
await pool.query(
  `update listings
      set status = 'in_review',
          reject_reason = null,
          submitted_at = now(),
          claimed_by = null,
          claimed_at = null
    where listing_id = $1`,
  [id],
);

await writeAudit({
  actor: "Moved from the database",
  area: "listing",
  action: "Moved a listing to review",
  target: l.card_name,
  detail: reason || "Moved to review by script.",
  weight: "normal",
});

console.log(`Moved to review queue. Written to the audit log.\n`);

await pool.end();
process.exit(0);
