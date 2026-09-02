import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";

// Communities, posts, comments, votes.
//
// The shape is Reddit's because that is the shape people already know: a
// community you join, posts ranked by more than recency, threaded replies,
// and one vote per person per thing. Nothing here is novel and that is the
// point — a forum that invents its own conventions makes people learn it
// before they can use it.

export const COMMUNITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS communities (
  community_id text PRIMARY KEY,
  slug         text UNIQUE NOT NULL,
  name         text NOT NULL,
  tagline      text,
  description  text,
  game         text,
  accent       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_members (
  community_id text NOT NULL,
  user_id      text NOT NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE IF NOT EXISTS posts (
  post_id      text PRIMARY KEY,
  community_id text NOT NULL,
  author_id    text NOT NULL,
  title        text NOT NULL,
  body         text,
  image_url    text,
  -- a post can hang off a card or a listing, which is the thing a card forum
  -- has that a general one does not
  catalog_id   text,
  listing_id   text,
  score        integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  removed      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_community ON posts (community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_new ON posts (created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  comment_id text PRIMARY KEY,
  post_id    text NOT NULL,
  parent_id  text,
  author_id  text NOT NULL,
  body       text NOT NULL,
  score      integer NOT NULL DEFAULT 0,
  removed    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_post ON comments (post_id, created_at);

CREATE TABLE IF NOT EXISTS votes (
  target_kind text NOT NULL,           -- 'post' | 'comment'
  target_id   text NOT NULL,
  user_id     text NOT NULL,
  value       smallint NOT NULL,       -- 1 or -1
  voted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_kind, target_id, user_id)
);
`;

/** The communities that exist on day one.
 *
 *  Seeded rather than left to users, because an empty forum with a "create a
 *  community" button is a room with no furniture. These are the five subjects
 *  the people already here actually talk about. */
const SEED = [
  { slug: "pokemon", name: "Pokémon TCG", game: "pokemon", accent: "#C8102E",
    tagline: "Base Set to Mega Evolution",
    description: "Pulls, grades, prices and the endless argument about whether Celebrations counts." },
  { slug: "onepiece", name: "One Piece TCG", game: "onepiece", accent: "#1B4F9C",
    tagline: "OP01 onward",
    description: "Leaders, alt arts, and Japanese prints nobody can read the price on." },
  { slug: "grading", name: "Grading", game: null, accent: "#0B3D2E",
    tagline: "PSA, Beckett, CGC, TAG",
    description: "Submission windows, turnaround times, and why the same card came back a 9." },
  { slug: "australia", name: "Australian Market", game: null, accent: "#A88D60",
    tagline: "Local buying, selling and meetups",
    description: "AU pricing, post vs pickup, card shows, and who is worth dealing with." },
  { slug: "grails", name: "Grails", game: null, accent: "#7A5AA8",
    tagline: "The one you are chasing",
    description: "Show the card you would not sell, and the one you are still hunting." },
];

export async function initCommunity(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(COMMUNITY_SCHEMA);
  for (const c of SEED) {
    await pool.query(
      `insert into communities (community_id, slug, name, tagline, description, game, accent)
       values ($1,$2,$3,$4,$5,$6,$7) on conflict (slug) do update
         set name = $3, tagline = $4, description = $5, accent = $7`,
      [`c_${c.slug}`, c.slug, c.name, c.tagline, c.description, c.game, c.accent],
    );
  }
}

/** Reddit's hot ranking, and the reason it is not "newest first".
 *
 *  A pure recency feed makes the last hour the whole forum; a pure score feed
 *  freezes on whatever won last month. This is the classic log-score plus
 *  age term: an order of magnitude more votes is worth about half a day.
 *
 *  Computed in SQL rather than in JS so the ordering can be done by the
 *  database over every post, instead of over whichever page we happened to
 *  fetch. */
const HOT = `
  (log(greatest(abs(p.score), 1)) * sign(p.score)::numeric
   + extract(epoch from p.created_at) / 45000)
`;

export type Row = Record<string, any>;

export async function listCommunities(userId: string | null): Promise<Row[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select c.*,
            (select count(*)::int from community_members m where m.community_id = c.community_id) as members,
            (select count(*)::int from posts p where p.community_id = c.community_id and not p.removed) as posts,
            ($1::text is not null and exists (
               select 1 from community_members m
                where m.community_id = c.community_id and m.user_id = $1)) as joined
       from communities c
      order by members desc, c.name`,
    [userId],
  );
  return r.rows;
}

export async function feed(opts: {
  slug?: string | null; sort?: string | null; userId?: string | null; limit?: number;
}): Promise<Row[]> {
  const pool = storePool();
  if (!pool) return [];
  const args: any[] = [opts.userId ?? null];
  let where = "not p.removed";
  if (opts.slug) { args.push(opts.slug); where += ` and c.slug = $${args.length}`; }

  const order =
    opts.sort === "new" ? "p.created_at desc"
    : opts.sort === "top" ? "p.score desc, p.created_at desc"
    : `${HOT} desc`;

  args.push(Math.min(opts.limit ?? 40, 100));
  const r = await pool.query(
    `select p.*, c.slug, c.name as community_name, c.accent,
            u.name as author_name,
            coalesce(v.value, 0) as my_vote
       from posts p
       join communities c on c.community_id = p.community_id
       left join users u on u.user_id = p.author_id
       left join votes v on v.target_kind = 'post' and v.target_id = p.post_id and v.user_id = $1
      where ${where}
      order by ${order}
      limit $${args.length}`,
    args,
  );
  return r.rows;
}

export async function getPost(postId: string, userId: string | null): Promise<Row | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select p.*, c.slug, c.name as community_name, c.accent, u.name as author_name,
            coalesce(v.value, 0) as my_vote
       from posts p
       join communities c on c.community_id = p.community_id
       left join users u on u.user_id = p.author_id
       left join votes v on v.target_kind = 'post' and v.target_id = p.post_id and v.user_id = $2
      where p.post_id = $1`,
    [postId, userId],
  );
  return r.rows[0] ?? null;
}

export async function commentsFor(postId: string, userId: string | null): Promise<Row[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select k.*, u.name as author_name, coalesce(v.value, 0) as my_vote
       from comments k
       left join users u on u.user_id = k.author_id
       left join votes v on v.target_kind = 'comment' and v.target_id = k.comment_id and v.user_id = $2
      where k.post_id = $1
      order by k.score desc, k.created_at asc`,
    [postId, userId],
  );
  return r.rows;
}

export async function createPost(p: {
  slug: string; authorId: string; title: string; body?: string | null;
  imageUrl?: string | null; catalogId?: string | null; listingId?: string | null;
}): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  const c = await pool.query("select community_id from communities where slug = $1", [p.slug]);
  const communityId = c.rows[0]?.community_id;
  if (!communityId) return null;

  const id = `p_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `insert into posts (post_id, community_id, author_id, title, body, image_url, catalog_id, listing_id, score)
     values ($1,$2,$3,$4,$5,$6,$7,$8,1)`,
    [id, communityId, p.authorId, p.title, p.body ?? null, p.imageUrl ?? null,
     p.catalogId ?? null, p.listingId ?? null],
  );
  // Posting is an upvote. It keeps a new post off the bottom of hot, and it
  // means the score never starts at zero, which reads as "nobody liked this"
  // rather than "nobody has seen it".
  await pool.query(
    `insert into votes (target_kind, target_id, user_id, value) values ('post',$1,$2,1)
     on conflict do nothing`, [id, p.authorId]);
  return id;
}

export async function addComment(c: {
  postId: string; authorId: string; body: string; parentId?: string | null;
}): Promise<string | null> {
  const pool = storePool();
  if (!pool) return null;
  const id = `k_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `insert into comments (comment_id, post_id, parent_id, author_id, body, score)
     values ($1,$2,$3,$4,$5,1)`,
    [id, c.postId, c.parentId ?? null, c.authorId, c.body],
  );
  await pool.query(
    `insert into votes (target_kind, target_id, user_id, value) values ('comment',$1,$2,1)
     on conflict do nothing`, [id, c.authorId]);
  await pool.query(
    "update posts set comment_count = comment_count + 1 where post_id = $1", [c.postId]);
  return id;
}

/** One vote per person per thing, and voting the same way twice takes it back.
 *
 *  The score is recomputed from the votes table rather than incremented, so a
 *  double-tap or a retried request cannot drift the number away from the
 *  votes that actually exist. */
export async function vote(
  kind: "post" | "comment", targetId: string, userId: string, value: 1 | 0 | -1,
): Promise<number | null> {
  const pool = storePool();
  if (!pool) return null;

  if (value === 0) {
    await pool.query(
      "delete from votes where target_kind=$1 and target_id=$2 and user_id=$3",
      [kind, targetId, userId]);
  } else {
    await pool.query(
      `insert into votes (target_kind, target_id, user_id, value) values ($1,$2,$3,$4)
       on conflict (target_kind, target_id, user_id)
       do update set value = $4, voted_at = now()`,
      [kind, targetId, userId, value]);
  }

  const sum = await pool.query(
    "select coalesce(sum(value),0)::int as score from votes where target_kind=$1 and target_id=$2",
    [kind, targetId]);
  const score = sum.rows[0]?.score ?? 0;
  await pool.query(
    kind === "post"
      ? "update posts set score = $2 where post_id = $1"
      : "update comments set score = $2 where comment_id = $1",
    [targetId, score]);
  return score;
}

export async function setMembership(
  slug: string, userId: string, join: boolean,
): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const c = await pool.query("select community_id from communities where slug = $1", [slug]);
  const id = c.rows[0]?.community_id;
  if (!id) return false;
  if (join) {
    await pool.query(
      `insert into community_members (community_id, user_id) values ($1,$2)
       on conflict do nothing`, [id, userId]);
  } else {
    await pool.query(
      "delete from community_members where community_id = $1 and user_id = $2", [id, userId]);
  }
  return true;
}
