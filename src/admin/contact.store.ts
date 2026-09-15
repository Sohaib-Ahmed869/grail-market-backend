import { storePool } from "../cards.store.js";
import { TtlCache } from "../scans/ttlcache.js";
import { writeAudit } from "./audit.store.js";
import { readSettings } from "./settings.store.js";
import { CONTACT_REVIEW_WINDOW_DAYS, classifyFlags, reviewDue } from "./contact.rules.js";

// Contact-sharing attempts, held against the account.
//
// Masking already ran on every message, post and comment, and each row kept
// its `flags` and what was really typed. Nothing ever read either. So a member
// could try to post a phone number forty times, have it masked forty times,
// and appear in the console as a spotless account — the record Sam asked for
// on 8 September did not exist.
//
// One row per flagged piece of text, written at the moment it is masked, so
// the count is a read of one indexed table rather than a scan of three content
// tables on every member page. The text itself stays where it was written;
// this row points at it.
//
// Coverage is stated, not implied: see `contact.rules.ts`. Nothing here claims
// a member with zero attempts has never shared a number.

export const CONTACT_SCHEMA = `
CREATE TABLE IF NOT EXISTS contact_attempts (
  -- '<source>:<ref>', so the same message can never be counted twice
  attempt_id text PRIMARY KEY,
  user_id    text NOT NULL,
  -- 'message' | 'post' | 'comment'
  source     text NOT NULL,
  ref        text NOT NULL,
  -- the thread or post it was said in, so the console can open the context
  context    text,
  flags      text[] NOT NULL,
  -- a contact DETAIL (phone, email, link, split number), as opposed to only
  -- naming an app. Only these count toward an automatic review.
  contact    boolean NOT NULL,
  -- whether the text was actually changed; false when masking was switched
  -- off in settings at the time
  masked     boolean NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_attempts_user ON contact_attempts (user_id, at DESC);
CREATE INDEX IF NOT EXISTS contact_attempts_at ON contact_attempts (at DESC);
-- The review this opens. Separate from the strike review in members.store.ts:
-- a masking rule firing is evidence for somebody to look at, not a decision,
-- and it must not count as a strike. Closed by a person, never by itself.
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_review_opened_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_review_closed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_review_closed_by text;
`;

/** Rows flagged before this table existed. Idempotent — the attempt id is the
 *  source and ref — and every block guarded, because a store that has not yet
 *  created the community tables must still boot. */
export async function backfillContactAttempts(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  const blocks: string[] = [
    `select 'message' as source, message_id as ref, sender_id as user_id, thread_id as context,
            flags, (raw_body is not null) as masked, created_at as at
       from messages where cardinality(flags) > 0`,
    `select 'post' as source, post_id as ref, author_id as user_id, post_id as context,
            flags, (raw_body is not null or raw_title is not null) as masked, created_at as at
       from posts where cardinality(flags) > 0`,
    `select 'comment' as source, comment_id as ref, author_id as user_id, post_id as context,
            flags, (raw_body is not null) as masked, created_at as at
       from comments where cardinality(flags) > 0`,
  ];
  for (const select of blocks) {
    try {
      const rows = await pool.query(select);
      for (const r of rows.rows) {
        const cls = classifyFlags(r.flags);
        if (!cls.record) continue;
        await pool.query(
          `insert into contact_attempts (attempt_id, user_id, source, ref, context, flags, contact, masked, at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (attempt_id) do nothing`,
          [`${r.source}:${r.ref}`, r.user_id, r.source, r.ref, r.context, r.flags, cls.contact, Boolean(r.masked), r.at],
        );
      }
    } catch {
      /* that content table is not there yet; nothing to backfill from it */
    }
  }
}

// ---- the interceptor switch -----------------------------------------------------

/** `interceptOn`, read on every message. Cached briefly, because a Postgres
 *  round trip per chat message to read one boolean that changes a few times a
 *  year is waste — and dropped the moment settings are saved, so switching it
 *  takes effect at once rather than after the cache runs out. */
const interceptCache = new TtlCache<boolean>(30_000, 4);
/** Bumped on every settings save. The key moves on, so the old answer is
 *  simply never read again — clearing by writing a blank value would read
 *  back as "off". */
let interceptGeneration = 0;

export async function interceptEnabled(): Promise<boolean> {
  const key = String(interceptGeneration);
  const hit = interceptCache.entry(key);
  if (hit) return hit.v;
  const on = (await readSettings()).interceptOn;
  interceptCache.set(key, on);
  return on;
}

export const forgetInterceptSetting = (): void => { interceptGeneration += 1; };

// ---- writing ----------------------------------------------------------------------

/**
 * Record one flagged piece of text, and open a review if it tips the member
 * over the limit.
 *
 * Never throws and is not awaited by the sender: the message has already been
 * written, and a moderation record that could stop a member sending is a
 * record that will one day stop the chat working.
 */
export async function recordContactAttempt(a: {
  userId: string;
  source: "message" | "post" | "comment";
  ref: string;
  context?: string | null;
  flags: readonly string[];
  masked: boolean;
}): Promise<void> {
  const cls = classifyFlags(a.flags);
  if (!cls.record) return;
  const pool = storePool();
  if (!pool) return;
  try {
    await pool.query(
      `insert into contact_attempts (attempt_id, user_id, source, ref, context, flags, contact, masked)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (attempt_id) do nothing`,
      [`${a.source}:${a.ref}`, a.userId, a.source, a.ref, a.context ?? null, [...a.flags], cls.contact, a.masked],
    );
    if (cls.contact) await maybeOpenReview(a.userId);
  } catch (e) {
    console.error("[contact] attempt not recorded:", (e as Error).message);
  }
}

async function maybeOpenReview(userId: string): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  const { contactReviewAfter } = await readSettings();
  const r = await pool.query(
    `select u.name,
            (u.contact_review_opened_at is not null
              and (u.contact_review_closed_at is null or u.contact_review_closed_at < u.contact_review_opened_at)) as open,
            (select count(*)::int from contact_attempts c
              where c.user_id = u.user_id and c.contact
                and c.at > now() - ($2 || ' days')::interval
                -- a review somebody closed starts the count again
                and c.at > coalesce(u.contact_review_closed_at, 'epoch'::timestamptz)) as n
       from users u where u.user_id = $1`,
    [userId, String(CONTACT_REVIEW_WINDOW_DAYS)],
  );
  const row = r.rows[0];
  if (!row) return;
  if (!reviewDue({ contactAttempts: row.n, limit: contactReviewAfter, open: Boolean(row.open) })) return;

  const opened = await pool.query(
    `update users set contact_review_opened_at = now()
      where user_id = $1
        and (contact_review_opened_at is null
             or (contact_review_closed_at is not null and contact_review_closed_at >= contact_review_opened_at))
      returning user_id`,
    [userId],
  );
  if ((opened.rowCount ?? 0) > 0) {
    void writeAudit({
      actor: "System",
      area: "conduct",
      action: "Opened a member review: contact details shared",
      target: row.name ?? userId,
      detail: `${row.n} contact-sharing attempts in ${CONTACT_REVIEW_WINDOW_DAYS} days reached the limit of ${contactReviewAfter}. Masking catches common patterns only.`,
      weight: "high",
    });
  }
}

/** Close a review. A person's decision, so it carries who and why. */
export async function closeContactReview(userId: string, by: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    `update users set contact_review_closed_at = now(), contact_review_closed_by = $2
      where user_id = $1 and contact_review_opened_at is not null
        and (contact_review_closed_at is null or contact_review_closed_at < contact_review_opened_at)
      returning user_id`,
    [userId, by],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---- reading ----------------------------------------------------------------------

export type ContactAttempt = {
  id: string;
  source: "message" | "post" | "comment";
  ref: string;
  context: string | null;
  flags: string[];
  contact: boolean;
  masked: boolean;
  at: string;
  /** What other members saw. */
  shown: string | null;
  /** What was actually typed — the phone number itself. Only returned to a
   *  role that decides conduct; see the controller. */
  typed?: string | null;
};

export type ContactSummary = {
  windowDays: number;
  /** contact DETAILS in the window, the figure the review counts */
  recentContact: number;
  /** everything recorded in the window, invitations included */
  recentAll: number;
  total: number;
  lastAt: string | null;
  reviewOpen: boolean;
  reviewOpenedAt: string | null;
  reviewClosedAt: string | null;
  reviewClosedBy: string | null;
  limit: number;
};

export async function memberContact(
  userId: string,
  opts: { withTyped: boolean; limit?: number },
): Promise<{ summary: ContactSummary; attempts: ContactAttempt[] } | null> {
  const pool = storePool();
  if (!pool) return null;
  const { contactReviewAfter } = await readSettings();
  const s = await pool.query(
    `select u.contact_review_opened_at, u.contact_review_closed_at, u.contact_review_closed_by,
            (select count(*)::int from contact_attempts c where c.user_id = u.user_id
               and c.contact and c.at > now() - ($2 || ' days')::interval) as recent_contact,
            (select count(*)::int from contact_attempts c where c.user_id = u.user_id
               and c.at > now() - ($2 || ' days')::interval) as recent_all,
            (select count(*)::int from contact_attempts c where c.user_id = u.user_id) as total,
            (select max(at) from contact_attempts c where c.user_id = u.user_id) as last_at
       from users u where u.user_id = $1`,
    [userId, String(CONTACT_REVIEW_WINDOW_DAYS)],
  );
  const row = s.rows[0];
  if (!row) return null;

  // The text is read back from where it was written. A deleted post simply
  // has none; the attempt still counts.
  const a = await pool.query(
    `select c.*,
            coalesce(m.body, p.body, p.title, k.body) as shown,
            coalesce(m.raw_body, p.raw_body, p.raw_title, k.raw_body) as typed
       from contact_attempts c
       left join messages m on c.source = 'message' and m.message_id = c.ref
       left join posts    p on c.source = 'post'    and p.post_id    = c.ref
       left join comments k on c.source = 'comment' and k.comment_id = c.ref
      where c.user_id = $1
      order by c.at desc
      limit $2`,
    [userId, Math.min(opts.limit ?? 50, 200)],
  ).catch(() => pool.query(
    // A store without the community tables yet: the record, without the text.
    `select c.*, null as shown, null as typed from contact_attempts c
      where c.user_id = $1 order by c.at desc limit $2`,
    [userId, Math.min(opts.limit ?? 50, 200)],
  ));

  const opened = row.contact_review_opened_at as Date | null;
  const closed = row.contact_review_closed_at as Date | null;
  return {
    summary: {
      windowDays: CONTACT_REVIEW_WINDOW_DAYS,
      recentContact: row.recent_contact ?? 0,
      recentAll: row.recent_all ?? 0,
      total: row.total ?? 0,
      lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
      reviewOpen: Boolean(opened && (!closed || closed < opened)),
      reviewOpenedAt: opened ? new Date(opened).toISOString() : null,
      reviewClosedAt: closed ? new Date(closed).toISOString() : null,
      reviewClosedBy: row.contact_review_closed_by ?? null,
      limit: contactReviewAfter,
    },
    attempts: a.rows.map((x: any) => ({
      id: x.attempt_id,
      source: x.source,
      ref: x.ref,
      context: x.context ?? null,
      flags: x.flags ?? [],
      contact: Boolean(x.contact),
      masked: Boolean(x.masked),
      at: new Date(x.at).toISOString(),
      shown: x.shown ?? null,
      ...(opts.withTyped ? { typed: x.typed ?? null } : {}),
    })),
  };
}

/** The whole platform over the window, for the policy page: what the rules
 *  caught, by kind, and how many members are sitting in an open review. */
export async function interceptSummary(): Promise<{
  windowDays: number;
  byFlag: { flag: string; hits: number }[];
  attempts: number;
  members: number;
  openReviews: number;
}> {
  const empty = { windowDays: CONTACT_REVIEW_WINDOW_DAYS, byFlag: [], attempts: 0, members: 0, openReviews: 0 };
  const pool = storePool();
  if (!pool) return empty;
  try {
    const window = String(CONTACT_REVIEW_WINDOW_DAYS);
    const [flags, totals, reviews] = await Promise.all([
      pool.query(
        `select f as flag, count(*)::int hits
           from contact_attempts, unnest(flags) f
          where at > now() - ($1 || ' days')::interval
          group by f order by hits desc`,
        [window],
      ),
      pool.query(
        `select count(*)::int attempts, count(distinct user_id)::int members
           from contact_attempts where at > now() - ($1 || ' days')::interval`,
        [window],
      ),
      pool.query(
        `select count(*)::int n from users
          where contact_review_opened_at is not null
            and (contact_review_closed_at is null or contact_review_closed_at < contact_review_opened_at)`,
      ),
    ]);
    return {
      windowDays: CONTACT_REVIEW_WINDOW_DAYS,
      byFlag: flags.rows,
      attempts: totals.rows[0]?.attempts ?? 0,
      members: totals.rows[0]?.members ?? 0,
      openReviews: reviews.rows[0]?.n ?? 0,
    };
  } catch {
    return empty;
  }
}
