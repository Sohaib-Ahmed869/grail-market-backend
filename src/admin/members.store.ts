import { storePool } from "../cards.store.js";
import { roleOf, ROLE_LABEL, type Role } from "./roles.js";

// The member record, as the console reads it.
//
// The feature set calls this the CRM: "one record per member: plan,
// verification level, badges, member since" and "the whole history in one
// place". Everything below is assembled from tables that already exist —
// `users`, `subscriptions`, `identity_status`, `listings`, `ratings` — because
// a member IS those things, and a second members table would be a copy that
// drifts from them.
//
// Nothing here writes except `setMemberNote` and the standing actions, which
// go through their own functions so there is one place each is enforced.

/* --------------------------------------------------------------------------
   The console's words for what the store holds
   -------------------------------------------------------------------------- */

/** Standing, which is not the same as billing. A member with a failed card is
 *  still in good standing; one we restricted is not, whatever they pay. */
export type MemberStatus = "active" | "restricted" | "revoked" | "pending";

export type PlanKey = "none" | "starter" | "collector" | "dealer";
export type BillingState = "active" | "past-due" | "cancelled" | "none";

/** The four funnel steps the dashboard counts. The last two are the provider's
 *  decision against the DVS; we hold the outcome and no documents. */
export type VerificationLevel = "none" | "mobile" | "id-submitted" | "id-verified";

export type AdminMember = {
  id: string;
  handle: string;
  name: string;
  initials: string;
  email: string;
  role: "buyer" | "seller" | "buyer-seller";
  status: MemberStatus;
  plan: PlanKey;
  billing: BillingState;
  verification: VerificationLevel;
  joined: string;
  lastSeen: string;
  lastSeenDays: number;
  country: string;
  sales: number;
  purchases: number;
  listed: number;
  liveListings: number;
  volume: number;
  rating: number;
  strikes: number;
  verifiedSeller: boolean;
  tags: string[];
  note?: string;
};

export type AdminStaff = {
  id: string;
  name: string;
  initials: string;
  email: string;
  role: Role;
  title: string;
  status: "active" | "restricted" | "revoked";
  since: string;
  grantedBy: string | null;
};

/**
 * Standing, and the note behind it.
 *
 * A restriction is a decision somebody took, so it carries who and why. It
 * lives on `users` beside the role rather than in a table of its own for the
 * same reason the role does: revoking is one write, and a member's standing
 * cannot go missing between two rows.
 */
export const MEMBERS_SCHEMA = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS standing text NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS standing_reason text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS standing_by text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS standing_at timestamptz;
-- Internal labels. Never shown to the member, per the feature set.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_tags jsonb NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_note text;
-- Read on every page of the directory.
CREATE INDEX IF NOT EXISTS users_standing ON users (standing);
`;

/* --------------------------------------------------------------------------
   One query per member row

   The counts are lateral subqueries rather than a pile of GROUP BY joins: a
   member with three listings and no sales must not have their listing count
   multiplied by an empty sales join, which is exactly what a chain of LEFT
   JOINs does to anyone with rows on two sides.
   -------------------------------------------------------------------------- */

const MEMBER_SQL = `
  select
    u.user_id, u.name, u.email, u.created_at, u.avatar,
    u.standing, u.standing_reason, u.admin_tags, u.admin_note,
    s.plan_id, s.status as billing_status,
    idn.status as identity, idn.verified_at,
    l.listed, l.live, l.sold, l.volume, l.last_listed,
    o.purchases,
    r.reviews, r.rating,
    coalesce(cc.n, 0) as strikes
  from users u
  left join subscriptions s on s.user_id = u.user_id
  left join identity_status idn on idn.user_id = u.user_id
  left join lateral (
    select count(*)::int                                              as listed,
           count(*) filter (where status in ('live','in_review'))::int as live,
           count(*) filter (where status = 'sold')::int                as sold,
           coalesce(sum(price) filter (where status = 'sold'), 0)::float as volume,
           max(created_at)                                            as last_listed
      from listings where seller_id = u.user_id
  ) l on true
  left join lateral (
    select count(*)::int purchases
      from offers where buyer_id = u.user_id and status = 'accepted'
  ) o on true
  left join lateral (
    select count(*)::int reviews, avg(stars)::float rating
      from ratings where ratee_id = u.user_id
  ) r on true
  -- Conduct decisions that landed on this member. A strike is a decision
  -- somebody took, not a report somebody filed — a case raised against you and
  -- then dismissed is not a mark on your record.
  left join lateral (
    select count(*)::int n from conduct_cases c
     where c.against_id = u.user_id
       and c.outcome is not null and c.outcome <> 'none'
  ) cc on true
  where u.role = 'member'
`;

export async function adminMembers(q: {
  search?: string | null;
  status?: string | null;
  plan?: string | null;
  verification?: string | null;
  limit?: number;
}): Promise<AdminMember[]> {
  const pool = storePool();
  if (!pool) return [];

  const where: string[] = [];
  const args: any[] = [];
  const add = (sql: string, v: any) => {
    args.push(v);
    where.push(sql.replace(/\?/g, `$${args.length}`));
  };

  // The console's box says "name, email or handle". A handle is derived from
  // the name, so matching the name covers it.
  if (q.search) add("(u.name ilike '%' || ? || '%' or u.email ilike '%' || ? || '%')", q.search.trim());
  if (q.status && q.status !== "all") add("u.standing = ?", q.status);
  if (q.plan && q.plan !== "all") {
    if (q.plan === "none") where.push("s.plan_id is null");
    else add("s.plan_id = ?", q.plan);
  }
  if (q.verification && q.verification !== "all") {
    const level = q.verification;
    if (level === "id-verified") where.push("idn.status = 'Approved'");
    else if (level === "id-submitted") where.push("idn.status is not null and idn.status <> 'Approved'");
    else where.push("idn.status is null");
  }

  args.push(Math.min(q.limit ?? 200, 500));
  const r = await pool.query(
    `${MEMBER_SQL} ${where.length ? `and ${where.join(" and ")}` : ""}
      order by u.created_at desc limit $${args.length}`,
    args,
  );
  return r.rows.map(shapeMember);
}

export async function adminMember(id: string): Promise<AdminMember | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(`${MEMBER_SQL} and u.user_id = $1`, [id]);
  return r.rows[0] ? shapeMember(r.rows[0]) : null;
}

/**
 * A member's history, dated.
 *
 * "Every listing, offer, trade, review, ticket and conduct action" is what the
 * feature set asks for. Three of those six have tables today; the timeline is
 * built from those and will take the rest as they land, rather than from a
 * separate events table that would have to be written to from six places and
 * would be wrong the first time one of them forgot.
 */
export async function memberTimeline(id: string, limit = 40) {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `(
       select 'listing' as kind, listing_id as ref, card_name as title,
              status as detail, coalesce(reviewed_at, submitted_at, created_at) as at,
              reviewed_by as by, price::float as amount
         from listings where seller_id = $1
     )
     union all
     (
       select 'offer', offer_id, 'Offer ' || status, note,
              coalesce(settled_at, created_at), null, amount::float
         from offers where buyer_id = $1 or seller_id = $1
     )
     union all
     (
       select 'review', rating_id, stars || ' stars', comment, created_at, null, null
         from ratings where ratee_id = $1
     )
     order by at desc limit $2`,
    [id, Math.min(limit, 200)],
  );
  return r.rows.map((x: any) => ({
    kind: x.kind as "listing" | "offer" | "review",
    ref: x.ref,
    title: x.title,
    detail: x.detail,
    at: iso(x.at),
    by: x.by,
    amount: x.amount,
  }));
}

/** Restrict, suspend, or put someone back. All audit-logged by the caller. */
export async function setStanding(
  id: string,
  standing: MemberStatus,
  reason: string,
  by: string,
): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    `update users set standing = $2, standing_reason = $3, standing_by = $4, standing_at = now()
      where user_id = $1 and role = 'member'`,
    [id, standing, reason || null, by],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Internal labels and the staff note. Never visible to the member. */
export async function annotateMember(
  id: string,
  patch: { tags?: string[]; note?: string | null },
): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const r = await pool.query(
    `update users set
       admin_tags = coalesce($2::jsonb, admin_tags),
       admin_note = coalesce($3, admin_note)
     where user_id = $1`,
    [id, patch.tags ? JSON.stringify(patch.tags) : null, patch.note ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

/* --------------------------------------------------------------------------
   The staff directory
   -------------------------------------------------------------------------- */

export async function adminStaff(): Promise<AdminStaff[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select user_id, name, email, role, standing, created_at, role_granted_by, role_granted_at
       from users where role <> 'member' order by role, name`,
  );
  return r.rows.map((x: any) => {
    const role = roleOf(x.role);
    return {
      id: x.user_id,
      name: x.name,
      initials: initialsFor(x.name),
      email: x.email,
      role,
      title: ROLE_LABEL[role],
      status: (["active", "restricted", "revoked"].includes(x.standing)
        ? x.standing
        : "active") as AdminStaff["status"],
      since: iso(x.role_granted_at ?? x.created_at),
      grantedBy: x.role_granted_by ?? null,
    };
  });
}

/* --------------------------------------------------------------------------
   Row → console
   -------------------------------------------------------------------------- */

function shapeMember(r: any): AdminMember {
  const name: string = r.name ?? "Unknown";
  const listed = Number(r.listed ?? 0);
  const purchases = Number(r.purchases ?? 0);
  const sales = Number(r.sold ?? 0);

  const lastSeenAt = r.last_listed ?? r.created_at;
  const lastSeenDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 86_400_000),
  );

  return {
    id: r.user_id,
    handle: handleFor(name, r.user_id),
    name,
    initials: initialsFor(name),
    email: r.email,
    // Derived, not declared: somebody who has listed is a seller, somebody who
    // has bought is a buyer, and most people turn out to be both.
    role: listed > 0 && purchases > 0 ? "buyer-seller" : listed > 0 ? "seller" : "buyer",
    status: standingOf(r.standing, r.identity),
    plan: planOf(r.plan_id),
    billing: billingOf(r.billing_status, r.plan_id),
    verification: verificationOf(r.identity),
    joined: iso(r.created_at),
    /* The store has no session table, so there is no true "last seen". Their
       most recent listing is the closest fact we hold, and it is labelled as
       activity rather than as a login so nobody reads it as one. */
    lastSeen: iso(lastSeenAt),
    lastSeenDays,
    country: "—",
    sales,
    purchases,
    listed,
    liveListings: Number(r.live ?? 0),
    volume: Number(r.volume ?? 0),
    rating: r.rating != null ? Number(r.rating) : 0,
    strikes: Number(r.strikes ?? 0),
    verifiedSeller: r.identity === "Approved" && sales > 0,
    tags: Array.isArray(r.admin_tags) ? r.admin_tags : [],
    note: r.admin_note ?? undefined,
  };
}

/** A member who has not finished the funnel is pending, not active — the
 *  directory's first job is telling those two apart. */
function standingOf(standing: unknown, identity: unknown): MemberStatus {
  const s = String(standing ?? "active");
  if (s === "restricted" || s === "revoked") return s;
  return identity === "Approved" ? "active" : "pending";
}

function planOf(planId: unknown): PlanKey {
  const p = String(planId ?? "").toLowerCase();
  return p === "starter" || p === "collector" || p === "dealer" ? p : "none";
}

/** Billing is Stripe's opinion; standing is ours. They are reported apart
 *  because a failed card is a dunning problem, not a conduct one. */
function billingOf(status: unknown, planId: unknown): BillingState {
  if (!planId) return "none";
  const s = String(status ?? "").toLowerCase();
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid" || s === "incomplete") return "past-due";
  if (s === "canceled" || s === "cancelled") return "cancelled";
  return "none";
}

function verificationOf(identity: unknown): VerificationLevel {
  const s = String(identity ?? "");
  if (s === "Approved") return "id-verified";
  if (!s || s === "Not Started") return "none";
  // Anything the provider has started but not approved: submitted, in review,
  // declined. The console shows the outcome, never a document.
  return "id-submitted";
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
