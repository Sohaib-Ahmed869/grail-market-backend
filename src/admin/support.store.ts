import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";

// The support desk.
//
// A new table, because nothing in the store modelled a ticket. `threads` and
// `messages` are a buyer talking to a seller about a listing; a support ticket
// is a member talking to us, and conflating the two would put staff replies
// into a conversation two members own.
//
// The feature set is specific about why this lives here at all: "ticketing
// inside this portal — no fourth platform to keep in sync". An outsourced desk
// gets accounts in this console rather than a separate helpdesk product, so
// tickets, listings, reports and conduct history stay in one database and
// nothing has to be synced between systems.

export const SUPPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS support_tickets (
  ticket_id   text PRIMARY KEY,
  member_id   text NOT NULL,
  subject     text NOT NULL,
  category    text NOT NULL DEFAULT 'General',
  -- 'new' | 'open' | 'waiting' | 'resolved'
  status      text NOT NULL DEFAULT 'new',
  -- 'urgent' | 'high' | 'normal' | 'low'
  priority    text NOT NULL DEFAULT 'normal',
  -- 'tier-1' | 'tier-2' | 'trust-safety'. Escalations move up, never sideways.
  tier        text NOT NULL DEFAULT 'tier-1',
  assignee    text,
  -- What the ticket is about, when it is about something: a listing, a case.
  listing_id  text,
  dispute_id  text,
  -- The first-reply clock stops here, once, and never restarts. A ticket that
  -- was answered late stays answered late however the conversation goes on.
  first_reply_at timestamptz,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_queue ON support_tickets (status, created_at);
CREATE INDEX IF NOT EXISTS support_member ON support_tickets (member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  message_id text PRIMARY KEY,
  ticket_id  text NOT NULL,
  -- 'member' | 'agent' | 'system'
  author     text NOT NULL,
  author_id  text,
  author_name text,
  body       text NOT NULL,
  -- An internal note is never shown to the member. It is on the ticket rather
  -- than in a second table so an agent reads one conversation, not two.
  internal   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_thread ON support_messages (ticket_id, created_at);
`;

/** The first-reply target, in hours, by priority. Stated on screen, so it
 *  lives once and both the badge and the breach count read the same number. */
export const REPLY_TARGET: Record<string, number> = {
  urgent: 1,
  high: 4,
  normal: 12,
  low: 24,
};

export const STATUSES = ["new", "open", "waiting", "resolved"] as const;
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export const TIERS = ["tier-1", "tier-2", "trust-safety"] as const;

export const isStatus = (v: string) => (STATUSES as readonly string[]).includes(v);
export const isPriority = (v: string) => (PRIORITIES as readonly string[]).includes(v);
export const isTier = (v: string) => (TIERS as readonly string[]).includes(v);

export type AdminTicket = {
  id: string;
  subject: string;
  preview: string;
  status: string;
  priority: string;
  tier: string;
  category: string;
  member: { id: string; handle: string; name: string; initials: string; role: string };
  opened: string;
  lastReply: string;
  slaHours: number;
  answered: boolean;
  assignee?: string;
  listingId?: string;
  disputeId?: string;
};

export type TicketMessage = {
  id: string;
  from: "member" | "admin" | "system";
  author: string;
  at: string;
  body: string;
  internal: boolean;
};

export async function initSupport(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(SUPPORT_SCHEMA);
}

/* --------------------------------------------------------------------------
   Reading
   -------------------------------------------------------------------------- */

const TICKET_SQL = `
  select
    t.*,
    u.name as member_name,
    coalesce(sold.n, 0) as member_sales,
    coalesce(bought.n, 0) as member_purchases,
    last.body as last_body,
    last.created_at as last_at
  from support_tickets t
  left join users u on u.user_id = t.member_id
  left join lateral (
    select count(*)::int n from listings where seller_id = t.member_id
  ) sold on true
  left join lateral (
    select count(*)::int n from offers where buyer_id = t.member_id
  ) bought on true
  left join lateral (
    select body, created_at from support_messages
     where ticket_id = t.ticket_id and internal = false
     order by created_at desc limit 1
  ) last on true
`;

export async function adminTickets(q: { status?: string | null } = {}): Promise<AdminTicket[]> {
  const pool = storePool();
  if (!pool) return [];
  const args: any[] = [];
  let where = "";
  if (q.status && q.status !== "all" && isStatus(q.status)) {
    args.push(q.status);
    where = "where t.status = $1";
  }
  const r = await pool.query(
    `${TICKET_SQL} ${where} order by
       -- unanswered first, then oldest: the SLA is on the first reply, so a
       -- ticket nobody has touched outranks one already in conversation
       case when t.first_reply_at is null then 0 else 1 end,
       t.created_at asc`,
    args,
  );
  return r.rows.map(shape);
}

export async function adminTicket(id: string): Promise<AdminTicket | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(`${TICKET_SQL} where t.ticket_id = $1`, [id]);
  return r.rows[0] ? shape(r.rows[0]) : null;
}

export async function ticketThread(id: string): Promise<TicketMessage[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select message_id, author, author_name, body, internal, created_at
       from support_messages where ticket_id = $1 order by created_at`,
    [id],
  );
  return r.rows.map((x: any) => ({
    id: x.message_id,
    from: (x.author === "agent" ? "admin" : x.author) as TicketMessage["from"],
    author: x.author_name ?? (x.author === "member" ? "Member" : "Grail Market"),
    at: iso(x.created_at),
    body: x.body,
    internal: Boolean(x.internal),
  }));
}

export async function ticketCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = { all: 0, new: 0, open: 0, waiting: 0, resolved: 0 };
  const pool = storePool();
  if (!pool) return out;
  const r = await pool.query("select status, count(*)::int n from support_tickets group by 1");
  for (const row of r.rows) {
    const n = Number(row.n);
    out.all += n;
    if (row.status in out) out[row.status] += n;
  }
  return out;
}

/** What else this member has going on, for the context panel beside a ticket. */
export async function ticketContext(memberId: string) {
  const pool = storePool();
  if (!pool) return { listings: [], cases: [] };
  const [listings, cases] = await Promise.all([
    pool.query(
      `select listing_id, card_name, grader, grade, price::float, status
         from listings where seller_id = $1 order by created_at desc limit 5`,
      [memberId],
    ),
    pool.query(
      `select dispute_id, reason, status, created_at
         from disputes where raised_by = $1 or against_id = $1
         order by created_at desc limit 5`,
      [memberId],
    ),
  ]);
  return {
    listings: listings.rows.map((x: any) => ({
      id: x.listing_id,
      card: x.card_name,
      grader: x.grader,
      grade: x.grade,
      price: x.price,
      status: x.status,
    })),
    cases: cases.rows.map((x: any) => ({
      id: x.dispute_id,
      reason: x.reason,
      status: x.status,
      at: iso(x.created_at),
    })),
  };
}

/* --------------------------------------------------------------------------
   Writing
   -------------------------------------------------------------------------- */

/**
 * A reply, from an agent.
 *
 * The first one stops the clock — once, and permanently. A ticket answered
 * late stays answered late however long the conversation runs afterwards,
 * which is the whole point of measuring a first reply rather than a last one.
 *
 * A reply also moves a `new` ticket to `open`, because a ticket somebody has
 * answered is not new any more and leaving it in the new pile means the next
 * agent picks it up again.
 */
export async function replyToTicket(
  id: string,
  by: { id: string; name: string },
  body: string,
  internal: boolean,
): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const exists = await pool.query("select 1 from support_tickets where ticket_id = $1", [id]);
  if (!exists.rowCount) return false;

  await pool.query(
    `insert into support_messages (message_id, ticket_id, author, author_id, author_name, body, internal)
     values ($1,$2,'agent',$3,$4,$5,$6)`,
    [`sm_${randomUUID().slice(0, 12)}`, id, by.id, by.name, body, internal],
  );

  // An internal note is not a reply to the member and must not stop the clock.
  if (!internal) {
    await pool.query(
      `update support_tickets set
         first_reply_at = coalesce(first_reply_at, now()),
         status = case when status = 'new' then 'open' else status end,
         assignee = coalesce(assignee, $2),
         updated_at = now()
       where ticket_id = $1`,
      [id, by.name],
    );
  }
  return true;
}

export async function setTicket(
  id: string,
  patch: { status?: string; priority?: string; tier?: string; assignee?: string | null },
): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    `update support_tickets set
       status   = coalesce($2, status),
       priority = coalesce($3, priority),
       tier     = coalesce($4, tier),
       assignee = coalesce($5, assignee),
       resolved_at = case when $2 = 'resolved' then now() else resolved_at end,
       updated_at = now()
     where ticket_id = $1`,
    [id, patch.status ?? null, patch.priority ?? null, patch.tier ?? null, patch.assignee ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Raised by an agent on a member's behalf — the third intake route in the
 *  feature set, alongside in-app help and email. */
export async function openTicket(t: {
  memberId: string;
  subject: string;
  body: string;
  category?: string;
  priority?: string;
  by: string;
}): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  const id = `sp_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `insert into support_tickets (ticket_id, member_id, subject, category, priority)
     values ($1,$2,$3,$4,$5)`,
    [id, t.memberId, t.subject, t.category ?? "General", t.priority ?? "normal"],
  );
  await pool.query(
    `insert into support_messages (message_id, ticket_id, author, author_name, body)
     values ($1,$2,'member',$3,$4)`,
    [`sm_${randomUUID().slice(0, 12)}`, id, `Raised by ${t.by}`, t.body],
  );
  return id;
}

/* --------------------------------------------------------------------------
   Row → console
   -------------------------------------------------------------------------- */

function shape(r: any): AdminTicket {
  const name: string = r.member_name ?? "Unknown";
  const target = REPLY_TARGET[String(r.priority)] ?? 12;
  const answered = r.first_reply_at != null;

  /* Hours left on the first-reply target, negative when over. It stops the
     moment somebody replies: a ticket answered in forty minutes does not get
     more overdue while the conversation continues. */
  const from = new Date(r.created_at).getTime();
  const until = answered ? new Date(r.first_reply_at).getTime() : Date.now();
  const slaHours = Math.round(target - (until - from) / 3_600_000);

  const sales = Number(r.member_sales ?? 0);
  const purchases = Number(r.member_purchases ?? 0);

  return {
    id: r.ticket_id,
    subject: r.subject,
    preview: (r.last_body ?? "").slice(0, 180),
    status: r.status,
    priority: r.priority,
    tier: r.tier,
    category: r.category,
    member: {
      id: r.member_id,
      handle: handleFor(name, r.member_id),
      name,
      initials: initialsFor(name),
      role: sales > 0 && purchases > 0 ? "buyer-seller" : sales > 0 ? "seller" : "buyer",
    },
    opened: iso(r.created_at),
    lastReply: iso(r.last_at ?? r.created_at),
    slaHours,
    answered,
    assignee: r.assignee ?? undefined,
    listingId: r.listing_id ?? undefined,
    disputeId: r.dispute_id ?? undefined,
  };
}

function handleFor(name: string, id: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug ? `@${slug}` : `@${id}`;
}

function initialsFor(name: string): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

const iso = (d: any) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
