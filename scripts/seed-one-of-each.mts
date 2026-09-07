/**
 * One conduct case and one support ticket, against whoever is actually in the
 * database.
 *
 *   npx tsx scripts/seed-one-of-each.mts
 *
 * `seed-cases.mts` and `seed-support.mts` are written against a fixture
 * database — jules, mia, dev — and die on the first `No account for …` when
 * pointed at a real one. That is why the conduct board and the support desk
 * are empty on a database with real accounts in it: there was no way to put
 * anything on either page.
 *
 * This puts one entry on each, and it works out who from the accounts that
 * exist: two members who are not staff, and a listing one of them actually
 * sold, so the case hangs off a real trade rather than off an invented one.
 *
 * Re-running it is a no-op. Both records are keyed on their own text — the
 * report, and the ticket's subject — so a second run finds them and leaves
 * them alone rather than seeding a duplicate of each.
 */
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const { storeConfigured, storePool } = await import("../src/cards.store.js");
const { initDisputes } = await import("../src/disputes/store.js");
const { initSupport } = await import("../src/admin/support.store.js");

if (!storeConfigured()) {
  console.error("DATABASE_URL is not set — nothing to seed.");
  process.exit(1);
}

await initDisputes();
await initSupport();
const pool = storePool()!;

/** Everyone who trades here, oldest first. Staff are excluded: a case against
 *  a moderator is a real thing the board handles, but it is the exception, and
 *  seeding one as the only case would show the board's rarest shape. */
async function members(): Promise<{ id: string; name: string; email: string }[]> {
  const r = await pool.query(
    `select user_id, name, email from users
      where coalesce(role, 'member') = 'member' and coalesce(standing, 'active') = 'active'
      order by created_at`,
  );
  return r.rows.map((x) => ({ id: x.user_id, name: x.name, email: x.email }));
}

/** A trade to hang the case on: something one of these members has sold, or
 *  failing that has on the market. A case needs a listing — that is what the
 *  two sides are arguing about. */
async function tradeBetween(people: { id: string }[]) {
  const ids = people.map((p) => p.id);
  const r = await pool.query(
    `select listing_id, seller_id, card_name from listings
      where seller_id = any($1)
        and status in ('sold', 'live')
      order by case status when 'sold' then 0 else 1 end, created_at
      limit 1`,
    [ids],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.listing_id as string, seller: row.seller_id as string, card: row.card_name as string };
}

const people = await members();
if (people.length < 2) {
  console.error(
    `Need two member accounts to seed a case between; this database has ${people.length}.`,
  );
  process.exit(1);
}

const trade = await tradeBetween(people);
if (!trade) {
  console.error("No member has a listing on the market or sold, so there is no trade to dispute.");
  process.exit(1);
}

const seller = people.find((p) => p.id === trade.seller)!;
/* The buyer is anybody but the seller. Nobody raises a case against
   themselves, and the API refuses it if they try. */
const buyer = people.find((p) => p.id !== seller.id)!;

/* ------------------------------------------------------------------ case */

const REPORT =
  "The card I collected is not the one in the listing photographs. The corners are soft on the bottom edge and there is a print line through the artwork that is not in any of the pictures. I asked him about it at the meet and he said it was the light.";

const ANSWER =
  "It is the card in the listing and the photos are the card. He looked at it for a minute in a car park and then wanted a hundred off. I said no and he walked away with it anyway.";

const existingCase = await pool.query(
  "select dispute_id from disputes where raised_by = $1 and against_id = $2 and detail = $3",
  [buyer.id, seller.id, REPORT],
);

if (existingCase.rows[0]) {
  console.log(`  case    ${existingCase.rows[0].dispute_id}  already seeded, left alone`);
} else {
  const caseId = `dp_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `insert into disputes
       (dispute_id, listing_id, raised_by, against_id, raiser_role, reason, detail, status, created_at)
     values ($1,$2,$3,$4,'buyer','not-as-described',$5,'open', now() - interval '20 hours')`,
    [caseId, trade.id, buyer.id, seller.id, REPORT],
  );

  /* The report itself, and the seller's answer. A case with only one side of
     it on the thread reads as though the other party has ignored it, which is
     a different case from the one where they have answered. */
  await pool.query(
    `insert into dispute_events (event_id, dispute_id, author_id, kind, body, created_at)
     values ($1,$2,$3,'comment',$4, now() - interval '20 hours')`,
    [`de_${randomUUID().slice(0, 12)}`, caseId, buyer.id, REPORT],
  );
  await pool.query(
    `insert into dispute_events (event_id, dispute_id, author_id, kind, body, created_at)
     values ($1,$2,$3,'comment',$4, now() - interval '13 hours')`,
    [`de_${randomUUID().slice(0, 12)}`, caseId, seller.id, ANSWER],
  );

  console.log(
    `  case    ${caseId}  not-as-described · ${buyer.name} against ${seller.name} · ${trade.card}`,
  );
}

/* ---------------------------------------------------------------- ticket */

const SUBJECT = "How do I move a listing to a different set?";

const existingTicket = await pool.query(
  "select ticket_id from support_tickets where member_id = $1 and subject = $2",
  [seller.id, SUBJECT],
);

if (existingTicket.rows[0]) {
  console.log(`  ticket  ${existingTicket.rows[0].ticket_id}  already seeded, left alone`);
} else {
  const ticketId = `sp_${randomUUID().slice(0, 12)}`;
  /* New, unassigned, and still inside its target. Something that arrives
     already breached shows the desk's alarm rather than its ordinary day. */
  await pool.query(
    `insert into support_tickets
       (ticket_id, member_id, subject, category, status, priority, tier, created_at, updated_at)
     values ($1,$2,$3,'Listing','new','normal','tier-1', now() - interval '3 hours', now())`,
    [ticketId, seller.id, SUBJECT],
  );
  await pool.query(
    `insert into support_messages (message_id, ticket_id, author, author_id, body, created_at)
     values ($1,$2,'member',$3,$4, now() - interval '3 hours')`,
    [
      `sm_${randomUUID().slice(0, 12)}`,
      ticketId,
      seller.id,
      "I listed a card under the wrong set and only noticed after it went live. Can the set be changed on a listing that is already up, or do I have to take it down and start again? It has watchers on it and I would rather not lose them.",
    ],
  );

  console.log(`  ticket  ${ticketId}  new · ${seller.name} · ${SUBJECT}`);
}

console.log("Done.");
await pool.end();
