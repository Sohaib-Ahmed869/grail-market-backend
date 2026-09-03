/**
 * A few support tickets, for working on the desk.
 *
 *   npx tsx scripts/seed-support.mts
 *
 * Four, chosen to cover the states the queue is laid out around: one urgent
 * and unanswered so the first-reply clock is visibly breached, one answered
 * and waiting on the member, one escalated to Tier 2, and one resolved. A
 * queue where every ticket is in the same state does not show whether the
 * queue works.
 *
 * Re-running it adds another set rather than editing the first.
 */
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "../src/env.js";

loadEnvFile();

const { storeConfigured, storePool } = await import("../src/cards.store.js");
const { initSupport } = await import("../src/admin/support.store.js");

if (!storeConfigured()) {
  console.error("DATABASE_URL is not set — nothing to seed.");
  process.exit(1);
}

await initSupport();
const pool = storePool()!;

async function userByEmail(email: string): Promise<string> {
  const r = await pool.query("select user_id from users where lower(email) = $1", [email]);
  const id = r.rows[0]?.user_id;
  if (!id) throw new Error(`No account for ${email}.`);
  return id;
}

async function seed(t: {
  email: string;
  subject: string;
  category: string;
  priority: "urgent" | "high" | "normal" | "low";
  tier?: "tier-1" | "tier-2" | "trust-safety";
  status?: "new" | "open" | "waiting" | "resolved";
  openedHoursAgo: number;
  /** The member's opening message. */
  from: string;
  /** Our reply, and how long after opening it went out. */
  reply?: { body: string; afterHours: number; by: string };
  assignee?: string;
}) {
  const memberId = await userByEmail(t.email);
  const id = `sp_${randomUUID().slice(0, 12)}`;

  await pool.query(
    `insert into support_tickets
       (ticket_id, member_id, subject, category, status, priority, tier, assignee,
        first_reply_at, resolved_at, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,
             case when $9::text is null then null else now() - ($9 || ' hours')::interval end,
             case when $10 = 'resolved' then now() else null end,
             now() - ($11 || ' hours')::interval,
             now())`,
    [
      id, memberId, t.subject, t.category, t.status ?? "new", t.priority,
      t.tier ?? "tier-1", t.assignee ?? null,
      t.reply ? String(t.openedHoursAgo - t.reply.afterHours) : null,
      t.status ?? "new",
      String(t.openedHoursAgo),
    ],
  );

  await pool.query(
    `insert into support_messages (message_id, ticket_id, author, author_id, author_name, body, created_at)
     values ($1,$2,'member',$3,$4,$5, now() - ($6 || ' hours')::interval)`,
    [`sm_${randomUUID().slice(0, 12)}`, id, memberId, null, t.from, String(t.openedHoursAgo)],
  );

  if (t.reply) {
    await pool.query(
      `insert into support_messages (message_id, ticket_id, author, author_name, body, created_at)
       values ($1,$2,'agent',$3,$4, now() - ($5 || ' hours')::interval)`,
      [
        `sm_${randomUUID().slice(0, 12)}`,
        id,
        t.reply.by,
        t.reply.body,
        String(t.openedHoursAgo - t.reply.afterHours),
      ],
    );
  }

  console.log(`  ${id}  ${(t.status ?? "new").padEnd(9)} ${t.priority.padEnd(7)} ${t.subject}`);
}

console.log("Seeding the support desk…");

// Urgent, nobody has answered, and the one-hour target went hours ago.
await seed({
  email: "sohaib@grailmarket.test",
  subject: "The member I reported is messaging me again",
  category: "Trust and safety",
  priority: "urgent",
  tier: "trust-safety",
  status: "new",
  openedHoursAgo: 3,
  from:
    "The case I raised closed with a warning four days ago and he has messaged me twice since. I do not want to deal with him.",
});

// Answered inside the target, now waiting on the member.
await seed({
  email: "jules@grailmarket.test",
  subject: "Do you take CGC and SGC slabs?",
  category: "Listing",
  priority: "normal",
  status: "waiting",
  openedHoursAgo: 40,
  assignee: "Grail Market Admin",
  from: "Do you take CGC and SGC slabs for the consignment programme, or PSA and BGS only?",
  reply: {
    body:
      "All four — PSA, BGS, CGC and TAG. They are priced apart, never converted between companies, so a CGC 9.5 is quoted from CGC 9.5 sales only.",
    afterHours: 2,
    by: "Grail Market Admin",
  },
});

// Escalated to Tier 2, still open.
await seed({
  email: "mia@grailmarket.test",
  subject: "Grail-tier review has been open five days",
  category: "Verification",
  priority: "high",
  tier: "tier-2",
  status: "open",
  openedHoursAgo: 26,
  assignee: "Grail Market Admin",
  from:
    "My listing is still sitting in review. I sent the auction invoice on Tuesday. Is anything else needed?",
  reply: {
    body: "Passing this to the moderator who holds grail-tier reviews. You will hear today.",
    afterHours: 3,
    by: "Grail Market Admin",
  },
});

// Closed.
await seed({
  email: "dev@grailmarket.test",
  subject: "Paid for a boost and nothing happened",
  category: "Billing",
  priority: "high",
  status: "resolved",
  openedHoursAgo: 96,
  assignee: "Grail Market Admin",
  from: "Bought a 7-day boost on Tuesday. The listing is in the same place it was.",
  reply: {
    body:
      "The charge went through but the boost was not applied — a fault our end. It is running now and I have added the four days you lost.",
    afterHours: 1,
    by: "Grail Market Admin",
  },
});

console.log("Done.");
await pool.end();
