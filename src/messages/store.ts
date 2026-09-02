import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";
import { censor } from "../community/censor.js";
import { notify } from "../notifications/store.js";

// Buyer and seller talking about one card.
//
// A thread belongs to a LISTING and a BUYER, not to two people in general.
// That is the OLX shape and it is the right one here: the conversation is
// about a specific card at a specific price, it starts when someone shows
// interest, and it ends when the card is sold. Two people who trade twice
// have two threads, and neither of them has to scroll past the other deal to
// find what was agreed.
//
// The same masking the forum uses applies here, and for a stronger reason:
// this is exactly where someone would try to move the deal off the platform.

export const MESSAGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  thread_id  text PRIMARY KEY,
  listing_id text NOT NULL,
  buyer_id   text NOT NULL,
  seller_id  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS threads_once ON threads (listing_id, buyer_id);
CREATE INDEX IF NOT EXISTS threads_buyer  ON threads (buyer_id, last_at DESC);
CREATE INDEX IF NOT EXISTS threads_seller ON threads (seller_id, last_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  message_id text PRIMARY KEY,
  thread_id  text NOT NULL,
  sender_id  text NOT NULL,
  body       text NOT NULL,
  raw_body   text,
  flags      text[] NOT NULL DEFAULT '{}',
  -- an offer, an acceptance and a sale all land in the thread as events, so
  -- the conversation reads as the history of the deal rather than as chat
  -- with the important parts happening somewhere else
  kind       text NOT NULL DEFAULT 'text',
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, created_at);

-- Reactions. One per person per message: tapping the same one again takes it
-- back, tapping a different one moves it. A message with fourteen reactions
-- from two people is a toy, not a conversation.
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id text NOT NULL,
  user_id    text NOT NULL,
  emoji      text NOT NULL,
  reacted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
`;

export async function initMessages(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(MESSAGES_SCHEMA);
}

/** Open the thread for this listing and buyer, or return the existing one. */
export async function openThread(
  listingId: string, buyerId: string,
): Promise<{ threadId: string; sellerId: string } | null> {
  const pool = storePool();
  if (!pool) return null;
  const l = await pool.query(
    "select seller_id, status from listings where listing_id = $1", [listingId]);
  const listing = l.rows[0];
  if (!listing) return null;
  if (listing.seller_id === buyerId) return null;   // nobody messages themselves

  const id = `t_${randomUUID().slice(0, 12)}`;
  const r = await pool.query(
    `insert into threads (thread_id, listing_id, buyer_id, seller_id)
     values ($1,$2,$3,$4)
     on conflict (listing_id, buyer_id) do update set last_at = threads.last_at
     returning thread_id`,
    [id, listingId, buyerId, listing.seller_id],
  );
  return { threadId: r.rows[0].thread_id, sellerId: listing.seller_id };
}

export async function threadsFor(userId: string): Promise<any[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select t.*, l.card_name, l.set_name, l.grader, l.grade, l.price, l.status as listing_status,
            l.image_url, l.photos,
            case when t.buyer_id = $1 then t.seller_id else t.buyer_id end as other_id,
            case when t.buyer_id = $1 then 'buyer' else 'seller' end as my_role,
            u.name as other_name, u.avatar as other_avatar,
            (select body from messages m where m.thread_id = t.thread_id
              order by m.created_at desc limit 1) as last_body,
            (select count(*)::int from messages m
              where m.thread_id = t.thread_id and m.sender_id <> $1 and m.read_at is null) as unread
       from threads t
       join listings l on l.listing_id = t.listing_id
       left join users u on u.user_id = (case when t.buyer_id = $1 then t.seller_id else t.buyer_id end)
      where t.buyer_id = $1 or t.seller_id = $1
      order by t.last_at desc`,
    [userId],
  );
  return r.rows;
}

export async function messagesIn(threadId: string, userId: string): Promise<any[] | null> {
  const pool = storePool();
  if (!pool) return null;
  const t = await pool.query(
    "select * from threads where thread_id = $1", [threadId]);
  const thread = t.rows[0];
  if (!thread) return null;
  if (thread.buyer_id !== userId && thread.seller_id !== userId) return null;

  // Reading marks the other side's messages read. Doing it here rather than
  // in a separate call means the badge cannot drift from what is on screen.
  await pool.query(
    `update messages set read_at = now()
      where thread_id = $1 and sender_id <> $2 and read_at is null`,
    [threadId, userId]);

  const r = await pool.query(
    `select m.message_id, m.thread_id, m.sender_id, m.body, m.kind, m.flags,
            m.read_at, m.created_at, u.name as sender_name, u.avatar as sender_avatar,
            coalesce(
              (select json_agg(json_build_object('emoji', x.emoji, 'userId', x.user_id))
                 from message_reactions x where x.message_id = m.message_id),
              '[]'::json) as reactions
       from messages m
       left join users u on u.user_id = m.sender_id
      where m.thread_id = $1 order by m.created_at`,
    [threadId]);
  return r.rows;
}

export async function say(
  threadId: string, senderId: string, body: string, kind = "text",
): Promise<{ messageId: string; masked: boolean } | null> {
  const pool = storePool();
  if (!pool) return null;
  const t = await pool.query("select * from threads where thread_id = $1", [threadId]);
  const thread = t.rows[0];
  if (!thread) return null;
  if (thread.buyer_id !== senderId && thread.seller_id !== senderId) return null;

  const c = censor(body);
  const id = `m_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `insert into messages (message_id, thread_id, sender_id, body, raw_body, flags, kind)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [id, threadId, senderId, c.text, c.masked ? body : null, c.hits, kind],
  );
  await pool.query("update threads set last_at = now() where thread_id = $1", [threadId]);

  const to = thread.buyer_id === senderId ? thread.seller_id : thread.buyer_id;
  const who = await pool.query("select name from users where user_id = $1", [senderId]);
  await notify({
    userId: to, kind: "message", actorId: senderId,
    title: `${who.rows[0]?.name ?? "Someone"} sent you a message`,
    body: c.text.slice(0, 140),
    href: `/messages/${threadId}`,
  });

  return { messageId: id, masked: c.masked };
}

/** An event in the deal, written into the conversation by the system. */
export async function note(listingId: string, buyerId: string, text: string): Promise<void> {
  const opened = await openThread(listingId, buyerId);
  if (!opened) return;
  const pool = storePool();
  if (!pool) return;
  const id = `m_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `insert into messages (message_id, thread_id, sender_id, body, kind)
     values ($1,$2,$3,$4,'event')`,
    [id, opened.threadId, "system", text]);
  await pool.query("update threads set last_at = now() where thread_id = $1", [opened.threadId]);
}

/** React, change reaction, or take it back by repeating it. */
export async function react(
  messageId: string, userId: string, emoji: string | null,
): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;

  // Only people in the thread may react to what is in it.
  const ok = await pool.query(
    `select 1 from messages m join threads t on t.thread_id = m.thread_id
      where m.message_id = $1 and (t.buyer_id = $2 or t.seller_id = $2)`,
    [messageId, userId]);
  if (!ok.rowCount) return false;

  if (!emoji) {
    await pool.query(
      "delete from message_reactions where message_id = $1 and user_id = $2",
      [messageId, userId]);
    return true;
  }
  await pool.query(
    `insert into message_reactions (message_id, user_id, emoji) values ($1,$2,$3)
     on conflict (message_id, user_id) do update
       set emoji = case when message_reactions.emoji = $3 then null else $3 end,
           reacted_at = now()`,
    [messageId, userId, emoji]);
  // the conflict branch above sets null to mean "took it back"
  await pool.query(
    "delete from message_reactions where message_id = $1 and user_id = $2 and emoji is null",
    [messageId, userId]);
  return true;
}

export async function unreadCount(userId: string): Promise<number> {
  const pool = storePool();
  if (!pool) return 0;
  const r = await pool.query(
    `select count(*)::int n from messages m
       join threads t on t.thread_id = m.thread_id
      where m.sender_id <> $1 and m.read_at is null
        and (t.buyer_id = $1 or t.seller_id = $1)`,
    [userId]);
  return r.rows[0]?.n ?? 0;
}
