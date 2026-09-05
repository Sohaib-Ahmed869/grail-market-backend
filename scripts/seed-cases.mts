/**
 * Three conduct cases, for working on the reports board.
 *
 *   npx tsx scripts/seed-cases.mts
 *
 * A case starts in `disputes`, raised by a member from the app, with the other
 * side's answer on `dispute_events`. Nothing here writes a `conduct_cases` row:
 * a case that has never been triaged is exactly what the console's "open" tab
 * is for, and seeding one already triaged would hide the state it starts in.
 *
 * Re-running it adds another set rather than editing the first.
 */
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const { storeConfigured, storePool } = await import("../src/cards.store.js");
const { initDisputes } = await import("../src/disputes/store.js");

if (!storeConfigured()) {
  console.error("DATABASE_URL is not set — nothing to seed.");
  process.exit(1);
}

await initDisputes();
const pool = storePool()!;

async function userByEmail(email: string): Promise<string> {
  const r = await pool.query("select user_id from users where lower(email) = $1", [email]);
  const id = r.rows[0]?.user_id;
  if (!id) throw new Error(`No account for ${email}.`);
  return id;
}

/** A live listing belonging to a given seller, for the case to hang off. */
async function listingOf(sellerId: string): Promise<{ id: string; card: string }> {
  const r = await pool.query(
    `select listing_id, card_name from listings
      where seller_id = $1 and status in ('live','sold') order by created_at limit 1`,
    [sellerId],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`No live listing for ${sellerId} to raise a case against.`);
  return { id: row.listing_id, card: row.card_name };
}

async function seed(c: {
  raiserEmail: string;
  againstEmail: string;
  raiserRole: "buyer" | "seller";
  reason: string;
  detail: string;
  /** The other side's answer, or nothing if they have not replied. */
  answer?: string;
  openedHoursAgo: number;
}) {
  const [raisedBy, againstId] = await Promise.all([
    userByEmail(c.raiserEmail),
    userByEmail(c.againstEmail),
  ]);
  /* The listing belongs to whichever of the two was selling — except when the
     accused is staff, who sell nothing, and the case is about how a decision
     was taken on the reporter's own listing. */
  const seller = c.raiserRole === "seller" ? raisedBy : againstId;
  const listing = await listingOf(seller).catch(() => listingOf(raisedBy));

  const id = `dp_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `insert into disputes
       (dispute_id, listing_id, raised_by, against_id, raiser_role, reason, detail, status, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,'open', now() - ($8 || ' hours')::interval)`,
    [id, listing.id, raisedBy, againstId, c.raiserRole, c.reason, c.detail, String(c.openedHoursAgo)],
  );

  await pool.query(
    `insert into dispute_events (event_id, dispute_id, author_id, kind, body, created_at)
     values ($1,$2,$3,'comment',$4, now() - ($5 || ' hours')::interval)`,
    [`de_${randomUUID().slice(0, 12)}`, id, raisedBy, c.detail, String(c.openedHoursAgo)],
  );

  if (c.answer) {
    await pool.query(
      `insert into dispute_events (event_id, dispute_id, author_id, kind, body, created_at)
       values ($1,$2,$3,'comment',$4, now() - ($5 || ' hours')::interval)`,
      [
        `de_${randomUUID().slice(0, 12)}`,
        id,
        againstId,
        c.answer,
        String(Math.max(0, c.openedHoursAgo - 6)),
      ],
    );
  }

  console.log(`  ${id}  ${c.reason.padEnd(18)} on ${listing.card}  (${c.openedHoursAgo}h old)`);
  return id;
}

console.log("Seeding the conduct board…");

// A buyer says the card is not what was listed, and the seller has answered.
await seed({
  raiserEmail: "jules@grailmarket.test",
  againstEmail: "dev@grailmarket.test",
  raiserRole: "buyer",
  reason: "not-as-described",
  detail:
    "The slab he brought to the meet is a PSA 9, not the PSA 10 in the listing. The cert on the label does not match the one in the listing photos.",
  answer:
    "I brought the card in the listing. He looked at it for thirty seconds in a car park and changed his mind about the price.",
  openedHoursAgo: 78,
});

// A seller says the buyer never turned up, and nobody has answered yet.
await seed({
  raiserEmail: "mia@grailmarket.test",
  againstEmail: "sohaib@grailmarket.test",
  raiserRole: "seller",
  reason: "not-received",
  detail:
    "We agreed a time and a place and he confirmed that morning. He did not turn up and has not answered two messages since. I travelled forty minutes each way.",
  openedHoursAgo: 30,
});

// A member reports a moderator. This is the one the board's staff filter is
// for: it must never queue beside a report about a seller, because the person
// who works the second is often the subject of the first.
await seed({
  raiserEmail: "sohaib@grailmarket.test",
  againstEmail: "admin@grailmarket.com",
  raiserRole: "buyer",
  reason: "other",
  detail:
    "My listing was rejected twice with the same one-line reason and the moderator will not say which photograph is wrong. I have asked three times.",
  openedHoursAgo: 12,
});

console.log("Done.");
await pool.end();
