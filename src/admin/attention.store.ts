import { storePool } from "../cards.store.js";
import { SLA_HOURS } from "./listings.store.js";
import { REPLY_TARGET } from "./support.store.js";

// What needs somebody now.
//
// The console's bell used to be an icon with "3 unread" written into its
// aria-label and no handler — a decoration that claimed to be a count. This is
// what a bell on an admin console should actually hold: not a member's
// notifications, which belong to the member, but the work that has gone past a
// line somebody promised it would not.
//
// Every item is derived, never stored. There is no "admin notification" table
// and there should not be one: an alert that has to be created and then
// dismissed goes stale the moment the underlying work is done by somebody
// else, and two operators would then be looking at different bells. Read it
// again and the answer is current by construction.
//
// Only breaches and blockages qualify. A queue with work in it is a normal
// Tuesday; a queue with work in it that is a day late is not. A bell that
// lights up for ordinary volume is a bell people learn to ignore.

export type Attention = {
  key: string;
  /** What is wrong, in one line. */
  title: string;
  /** How many, so the row can be read without opening it. */
  count: number;
  /** Where to go and deal with it. */
  href: string;
  /** `bad` is past a promise; `warn` is close to one. */
  tone: "bad" | "warn";
};

export async function attention(): Promise<Attention[]> {
  const pool = storePool();
  if (!pool) return [];

  const one = async (sql: string, args: any[] = []): Promise<number> => {
    try {
      const r = await pool.query(sql, args);
      return Number(r.rows[0]?.n ?? 0);
    } catch {
      /* A source that cannot be read contributes nothing rather than taking
         the whole bell down with it. */
      return 0;
    }
  };

  const [overdueListings, dueSoon, breachedTickets, unclaimedCases, stuckBoosts] =
    await Promise.all([
      one(
        `select count(*)::int n from listings
          where status = 'in_review'
            and submitted_at < now() - ($1 || ' hours')::interval`,
        [String(SLA_HOURS)],
      ),
      one(
        `select count(*)::int n from listings
          where status = 'in_review'
            and submitted_at < now() - ($1 || ' hours')::interval
            and submitted_at >= now() - ($2 || ' hours')::interval`,
        [String(SLA_HOURS - 4), String(SLA_HOURS)],
      ),
      /* The first-reply clock, which is per priority rather than one number —
         an urgent ticket is late after an hour and a low one after a day. */
      one(
        `select count(*)::int n from support_tickets t
          where t.status <> 'resolved'
            and t.first_reply_at is null
            and t.created_at < now() - (
              case t.priority
                when 'urgent' then interval '${REPLY_TARGET.urgent} hours'
                when 'high'   then interval '${REPLY_TARGET.high} hours'
                when 'low'    then interval '${REPLY_TARGET.low} hours'
                else               interval '${REPLY_TARGET.normal} hours'
              end)`,
      ),
      one(
        `select count(*)::int n from conduct_cases
          where state <> 'resolved' and claimed_by is null
            and updated_at < now() - interval '24 hours'`,
      ),
      /* Charged for and never ran. The one item here that is somebody being
         out of pocket rather than somebody waiting. */
      one(
        `select count(*)::int n from listing_boosts
          where applied_at is null and comped_at is null
            and purchased_at < now() - interval '2 hours'`,
      ),
    ]);

  const out: Attention[] = [];

  if (overdueListings > 0) {
    out.push({
      key: "listings-overdue",
      title: `${overdueListings} listing${overdueListings === 1 ? "" : "s"} past the ${SLA_HOURS}h review target`,
      count: overdueListings,
      href: "/admin/listings?view=queue",
      tone: "bad",
    });
  } else if (dueSoon > 0) {
    out.push({
      key: "listings-soon",
      title: `${dueSoon} listing${dueSoon === 1 ? "" : "s"} due for review within 4 hours`,
      count: dueSoon,
      href: "/admin/listings?view=queue",
      tone: "warn",
    });
  }

  if (breachedTickets > 0) {
    out.push({
      key: "tickets-breached",
      title: `${breachedTickets} ticket${breachedTickets === 1 ? " is" : "s are"} past the first-reply target`,
      count: breachedTickets,
      href: "/admin/support?status=new",
      tone: "bad",
    });
  }

  if (unclaimedCases > 0) {
    out.push({
      key: "cases-unclaimed",
      title: `${unclaimedCases} conduct case${unclaimedCases === 1 ? "" : "s"} open and unclaimed for a day`,
      count: unclaimedCases,
      href: "/admin/conflicts",
      tone: "warn",
    });
  }

  if (stuckBoosts > 0) {
    out.push({
      key: "boosts-stuck",
      title: `${stuckBoosts} boost${stuckBoosts === 1 ? " was" : "s were"} charged for and never ran`,
      count: stuckBoosts,
      href: "/admin/pricing",
      tone: "bad",
    });
  }

  return out;
}
