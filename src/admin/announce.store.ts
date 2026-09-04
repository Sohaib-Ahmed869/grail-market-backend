import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";

// Announcements: broadcasts, the in-app banner, and anything queued to go out.
//
// One table of our own. It is not `notifications`: a notification is one row
// per member about their own listing, and a broadcast is one row about a thing
// that happened to everybody. Writing a broadcast as ten thousand
// notifications would make "what did we send, to whom, and how many got it" a
// query over ten thousand rows instead of a field.
//
// What actually leaves the building is a separate problem. Push and email need
// a provider neither of which is wired, so a send records what was sent and to
// how many — `delivered` says plainly whether anything left. A page that
// claims "sent to 5,218" when nothing was dispatched is worse than one that
// says it recorded the send and could not dispatch it.

export const ANNOUNCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS announcements (
  announcement_id text PRIMARY KEY,
  title      text NOT NULL,
  body       text NOT NULL,
  -- 'push' | 'email' | 'banner', any combination
  channels   text[] NOT NULL DEFAULT '{}',
  -- a segment key, or 'all'
  audience   text NOT NULL DEFAULT 'all',
  -- 'info' | 'outage' | 'policy'
  tone       text NOT NULL DEFAULT 'info',
  -- 'scheduled' | 'sent' | 'live' | 'cancelled' | 'taken-down'
  state      text NOT NULL DEFAULT 'scheduled',
  -- when it goes, or went
  at         timestamptz NOT NULL DEFAULT now(),
  -- banners only: when it comes down on its own
  until      timestamptz,
  by_name    text NOT NULL,
  by_id      text,
  -- how many accounts it was addressed to, counted at the moment it went
  reach      integer,
  -- whether anything actually left the building. False until a push/email
  -- provider is wired; the console says so rather than implying delivery.
  delivered  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS announcements_state ON announcements (state, at DESC);
`;

export const CHANNELS = ["push", "email", "banner"] as const;
export const TONES = ["info", "outage", "policy"] as const;

export type Channel = (typeof CHANNELS)[number];
export type Tone = (typeof TONES)[number];

export const isChannel = (c: string): c is Channel =>
  (CHANNELS as readonly string[]).includes(c);
export const isTone = (t: string): t is Tone => (TONES as readonly string[]).includes(t);

export type Announcement = {
  id: string;
  title: string;
  body: string;
  channels: Channel[];
  audience: string;
  tone: Tone;
  state: "scheduled" | "sent" | "live" | "cancelled" | "taken-down";
  at: string;
  until?: string;
  by: string;
  reach?: number;
  delivered: boolean;
};

/* --------------------------------------------------------------------------
   Audience

   A segment is a WHERE clause over `users`, and the count is what the compose
   screen promises before anybody presses send. It has to be the same clause
   both times or the button lies about who it is about to write to.

   The keys match the console's `segments`. Anything unrecognised falls back to
   everybody rather than to nobody: a broadcast that silently reaches no one is
   the failure mode that goes unnoticed.
   -------------------------------------------------------------------------- */

const LAPSED_DAYS = 60;

/**
 * The segments, as WHERE clauses over `users u`.
 *
 * These have to agree with `members.store.ts`, which is where the console's
 * member directory gets the same words from. Two definitions of "lapsed"
 * would mean the directory and the compose screen disagree about who is about
 * to be written to, and only one of them would be on screen at the time.
 *
 * In particular there is no `users.last_seen_at` column: the directory derives
 * last-seen as the member's most recent listing, falling back to when they
 * joined, and this does the same.
 */
const SEGMENT_SQL: Record<string, string> = {
  all: "true",
  lapsed: `u.standing is distinct from 'revoked'
           and coalesce(
                 (select max(l.created_at) from listings l where l.seller_id = u.user_id),
                 u.created_at
               ) < now() - interval '${LAPSED_DAYS} days'`,
  "never-listed": "not exists (select 1 from listings l where l.seller_id = u.user_id)",
  unverified: `not exists (
                 select 1 from identity_status i
                  where i.user_id = u.user_id and i.status = 'Approved')`,
  /* Stripe's opinion, in Stripe's own words — the same set `billingOf` maps to
     past-due and cancelled. A plan is required: no plan is not a billing
     problem, it is a free account. */
  billing: `exists (select 1 from subscriptions s
                     where s.user_id = u.user_id
                       and s.plan_id is not null
                       and lower(s.status) in
                           ('past_due','unpaid','incomplete','canceled','cancelled'))`,
};

export const isSegment = (k: string) => Object.hasOwn(SEGMENT_SQL, k);

/**
 * How many accounts a segment names, right now.
 *
 * A missing table is not zero recipients. `lapsed` leans on a column the auth
 * module may not have added yet, and answering "0 members" would send an
 * operator looking for a bug in their segment rather than in our schema — so
 * an unreadable segment answers null and the console says it could not count.
 */
export async function reachOf(segment: string): Promise<number | null> {
  const pool = storePool();
  if (!pool) return null;
  const clause = SEGMENT_SQL[segment] ?? SEGMENT_SQL.all;
  try {
    const r = await pool.query(
      `select count(*)::int n from users u where u.role = 'member' and (${clause})`,
    );
    return r.rows[0]?.n ?? 0;
  } catch {
    return null;
  }
}

/** Every segment with its current size, for the compose screen's dropdown. */
export async function audiences(): Promise<{ key: string; reach: number | null }[]> {
  return Promise.all(
    Object.keys(SEGMENT_SQL).map(async (key) => ({ key, reach: await reachOf(key) })),
  );
}

/* --------------------------------------------------------------------------
   Reading
   -------------------------------------------------------------------------- */

export async function allAnnouncements(limit = 200): Promise<Announcement[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select * from announcements order by at desc limit $1`,
    [Math.min(limit, 500)],
  );
  return r.rows.map(shape);
}

/**
 * The banner on the app right now, if any.
 *
 * "Only one runs at a time" is a claim the console makes on screen, so it is
 * enforced here rather than asserted there — see `publish`. A banner past its
 * own `until` is not live any more whatever the column says, because nothing
 * runs a sweep to take it down.
 */
export async function liveBanner(): Promise<Announcement | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select * from announcements
      where state = 'live' and (until is null or until > now())
      order by at desc limit 1`,
  );
  return r.rows[0] ? shape(r.rows[0]) : null;
}

/* --------------------------------------------------------------------------
   Writing
   -------------------------------------------------------------------------- */

export async function publish(a: {
  title: string;
  body: string;
  channels: Channel[];
  audience: string;
  tone: Tone;
  /** now = send or raise the banner; later = queue it. */
  when: "now" | "later";
  at?: string | null;
  until?: string | null;
  byName: string;
  byId?: string | null;
}): Promise<Announcement | null> {
  const pool = storePool();
  if (!pool) return null;

  const isBanner = a.channels.includes("banner");
  const state = a.when === "later" ? "scheduled" : isBanner ? "live" : "sent";
  const at = a.when === "later" && a.at ? new Date(a.at) : new Date();
  const reach = a.when === "later" ? null : await reachOf(a.audience);

  /* One banner at a time, and it is this table that has to hold the line. The
     console says "anything new replaces it", so the outgoing one is taken
     down in the same breath rather than left live behind the new one. */
  if (state === "live") {
    await pool.query(
      `update announcements set state = 'taken-down' where state = 'live'`,
    );
  }

  const id = `an_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `insert into announcements
       (announcement_id, title, body, channels, audience, tone, state, at, until,
        by_name, by_id, reach, delivered)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false)`,
    [
      id,
      a.title.slice(0, 200),
      a.body.slice(0, 4000),
      a.channels,
      a.audience,
      a.tone,
      state,
      at,
      a.until ? new Date(a.until) : null,
      a.byName,
      a.byId ?? null,
      reach,
    ],
  );
  const r = await pool.query("select * from announcements where announcement_id = $1", [id]);
  return r.rows[0] ? shape(r.rows[0]) : null;
}

/**
 * Cancel a queued send, or take a live banner down.
 *
 * Nothing is deleted. A broadcast that was queued and pulled is a thing that
 * happened and the audit log points at it; removing the row would leave the
 * entry pointing at nothing.
 */
export async function setState(
  id: string,
  state: "cancelled" | "taken-down",
): Promise<Announcement | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `update announcements set state = $2
      where announcement_id = $1 and state in ('scheduled','live')
      returning *`,
    [id, state],
  );
  return r.rows[0] ? shape(r.rows[0]) : null;
}

export async function getAnnouncement(id: string): Promise<Announcement | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query("select * from announcements where announcement_id = $1", [id]);
  return r.rows[0] ? shape(r.rows[0]) : null;
}

/** A row, in the console's words. Exported for the test. */
export function shape(row: any): Announcement {
  const channels = (Array.isArray(row.channels) ? row.channels : []).filter(isChannel);
  return {
    id: row.announcement_id,
    title: row.title,
    body: row.body,
    channels,
    audience: row.audience,
    tone: isTone(row.tone) ? row.tone : "info",
    state: ["scheduled", "sent", "live", "cancelled", "taken-down"].includes(row.state)
      ? row.state
      : "sent",
    at: new Date(row.at).toISOString(),
    until: row.until ? new Date(row.until).toISOString() : undefined,
    by: row.by_name,
    reach: row.reach ?? undefined,
    delivered: Boolean(row.delivered),
  };
}
