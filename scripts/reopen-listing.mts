/**
 * Put a withdrawn listing back on the market.
 *
 *   npx tsx scripts/reopen-listing.mts l_1fbb679d-c40
 *
 * Withdrawal is final in the state machine — `TRANSITIONS.withdrawn` is an
 * empty array, so `moveListing` refuses this and so does the console, which
 * says as much on the record: "This listing is closed. Reopening it is an
 * audit-log action."
 *
 * That sentence is a promise, and this is the thing that keeps it. Reopening
 * is deliberately not a button: withdrawing pulls a listing off the market and
 * tells the seller it is over, and a state anybody can undo with one click is
 * not a state anybody can rely on. What it is instead is a decision somebody
 * takes with access to the database, and the whole point of calling it "an
 * audit-log action" is that it lands in the log under a real name rather than
 * as an unexplained row that changed itself overnight.
 *
 * So this does exactly what the console would have done — the same column
 * writes as `moveListing(id, "live")`, and the same audit entry the market
 * route writes — and refuses everything else. It will not reopen a listing
 * that was rejected (that is a decision, and it has its own way back through
 * review), one that sold, or one that is already live.
 */
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const { storeConfigured, storePool } = await import("../src/cards.store.js");
const { writeAudit } = await import("../src/admin/audit.store.js");

const id = process.argv[2]?.trim();
const reason = process.argv.slice(3).join(" ").trim();

if (!id) {
  console.error("Usage: npx tsx scripts/reopen-listing.mts <listing-id> [reason]");
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

/* Only from withdrawn. A rejected listing has a way back through review and
   should take it; a sold one is somebody else's card now. */
if (l.status !== "withdrawn") {
  console.error(
    `Only a withdrawn listing can be reopened this way, and this one is ${l.status}. Nothing changed.`,
  );
  await pool.end();
  process.exit(1);
}

/* The same columns `moveListing` writes on the way to `live`, so a listing
   reopened here is indistinguishable from one that was never withdrawn —
   except in the log, which is where the difference belongs. */
await pool.query(
  `update listings
      set status = 'live',
          reject_reason = null,
          live_at = now(),
          reviewed_at = now()
    where listing_id = $1`,
  [id],
);

await writeAudit({
  actor: "Reopened from the database",
  area: "listing",
  action: "Put a withdrawn listing back on the market",
  target: l.card_name,
  detail: reason || "Reopened by hand. The console cannot do this — withdrawal is final.",
  /* High, for the same reason withdrawing is: it changes what a member has on
     the market without them asking. */
  weight: "high",
});

console.log(`Back on the market. Written to the audit log.\n`);

await pool.end();
process.exit(0);
