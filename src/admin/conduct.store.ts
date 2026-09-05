import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";

// Reports & conduct.
//
// A case starts life in `disputes`, which is where a member raises one from the
// app. The console does not read it as a dispute: the feature set is explicit
// that "no refund pipeline, by design — no money passes through the platform",
// so a case here closes on standing. Warn, restrict, close the account, refer
// to police. Nothing about a refund.
//
// That mismatch is why this file exists rather than the console reading
// `disputes` directly. The dispute record stays exactly as the app writes it —
// another module owns it — and the conduct decision is a row of ours beside it.

/* --------------------------------------------------------------------------
   Our half of the record
   -------------------------------------------------------------------------- */

export const CONDUCT_SCHEMA = `
-- The console's view of a dispute: who is working it, what was decided about
-- the people in it, and the note behind the decision.
--
-- Keyed on the dispute rather than carrying its own case id, so there is one
-- case and not two records of it that can disagree about who it is against.
CREATE TABLE IF NOT EXISTS conduct_cases (
  dispute_id   text PRIMARY KEY,
  -- 'open' | 'awaiting-evidence' | 'escalated' | 'resolved'
  state        text NOT NULL DEFAULT 'open',
  claimed_by   text,
  claimed_at   timestamptz,
  -- 'none' | 'warned' | 'restricted' | 'closed' | 'police'
  outcome      text,
  outcome_note text,
  -- which side the outcome landed on, because a case has two people in it
  against_id   text,
  decided_by   text,
  decided_at   timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conduct_state ON conduct_cases (state, updated_at DESC);
`;

/** What a case can end as. Deliberately small: anything finer is a sentence
 *  in the note, not a new code for the rest of the system to reason about. */
export const OUTCOMES = ["none", "warned", "restricted", "closed", "police"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const isOutcome = (o: string): o is Outcome =>
  (OUTCOMES as readonly string[]).includes(o);

export const STATES = ["open", "awaiting-evidence", "escalated", "resolved"] as const;
export type CaseState = (typeof STATES)[number];
export const isState = (s: string): s is CaseState =>
  (STATES as readonly string[]).includes(s);

/**
 * The kinds a moderator sorts by.
 *
 * The app's own reason codes are about a transaction going wrong; these are
 * about behaviour. The mapping is one-way and lives here — `off-platform` has
 * no reason code at all yet, because the chat interceptor that would raise it
 * is a settings feature that has not landed.
 */
export type ConflictKind =
  | "not-as-described"
  | "off-platform"
  | "no-show"
  | "threats"
  | "counterfeit";

const KIND_BY_REASON: Record<string, ConflictKind> = {
  "not-as-described": "not-as-described",
  damaged: "not-as-described",
  "wrong-item": "not-as-described",
  counterfeit: "counterfeit",
  "not-received": "no-show",
  "not-paid": "no-show",
  "returned-empty": "not-as-described",
  other: "threats",
};

export const kindOf = (reason: unknown): ConflictKind =>
  KIND_BY_REASON[String(reason ?? "")] ?? "not-as-described";

export type CaseParty = {
  id: string;
  handle: string;
  name: string;
  initials: string;
  verified: boolean;
  /** Holds a console role. */
  staff: boolean;
  /** Cases previously raised against this person, this one excluded. */
  priorCases: number;
  /** When they joined. Context for how new an account making a report is. */
  joined: string | null;
};

export type AdminCase = {
  id: string;
  kind: ConflictKind;
  status: CaseState;
  opened: string;
  ageHours: number;
  amount: number;
  detail: string;
  raisedBy: CaseParty;
  against: CaseParty;
  /** Whether anyone in this case holds a console role. The board sorts by it:
   *  a report about a member of staff is a different conversation from a
   *  report about a member, and must not sit in the same pile. */
  involvesStaff: boolean;
  raiserRole: string;
  listing: {
    id: string;
    card: string;
    setLine: string;
    grader: string;
    grade: string;
    art?: string;
  } | null;
  claimedBy?: string;
  outcome?: Outcome;
  outcomeNote?: string;
  decidedBy?: string;
  decidedAt?: string;
};

export async function initConduct(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(CONDUCT_SCHEMA);
}

/* --------------------------------------------------------------------------
   Reading
   -------------------------------------------------------------------------- */

const CASE_SQL = `
  select
    d.dispute_id, d.reason, d.detail, d.created_at, d.raiser_role,
    d.raised_by, d.against_id, d.listing_id,
    c.state, c.claimed_by, c.outcome, c.outcome_note, c.decided_by, c.decided_at,
    ru.name as raiser_name, ri.status as raiser_identity, ru.role as raiser_role_col,
    ru.created_at as raiser_since,
    au.name as against_name, ai.status as against_identity, au.role as against_role_col,
    au.created_at as against_since,
    rp.n as raiser_prior, ap.n as against_prior,
    l.card_name, l.set_name, l.card_number, l.variant, l.grader, l.grade,
    l.image_url, l.price::float as amount
  from disputes d
  left join conduct_cases c on c.dispute_id = d.dispute_id
  left join users ru on ru.user_id = d.raised_by
  left join users au on au.user_id = d.against_id
  left join identity_status ri on ri.user_id = d.raised_by
  left join identity_status ai on ai.user_id = d.against_id
  left join listings l on l.listing_id = d.listing_id
  left join lateral (
    select count(*)::int n from disputes p
     where p.against_id = d.raised_by and p.dispute_id <> d.dispute_id
  ) rp on true
  left join lateral (
    select count(*)::int n from disputes p
     where p.against_id = d.against_id and p.dispute_id <> d.dispute_id
  ) ap on true
`;

export async function adminCases(
  q: { state?: string | null; party?: string | null } = {},
): Promise<AdminCase[]> {
  const pool = storePool();
  if (!pool) return [];
  const args: any[] = [];
  const where: string[] = [];

  if (q.state && q.state !== "all" && isState(q.state)) {
    args.push(q.state);
    // A dispute with no conduct row of its own has not been triaged, which is
    // exactly what "open" means. `coalesce` is what keeps those in the tab.
    where.push(`coalesce(c.state, 'open') = $${args.length}`);
  }

  // A case with staff on either side, or one with none. Reporting a moderator
  // is not the same job as reporting a seller, and the two must not queue
  // together — whoever handles the second should not be handling the first.
  if (q.party === "staff") {
    where.push(`(ru.role <> 'member' or au.role <> 'member')`);
  } else if (q.party === "members") {
    where.push(`(coalesce(ru.role, 'member') = 'member' and coalesce(au.role, 'member') = 'member')`);
  }

  const r = await pool.query(
    `${CASE_SQL} ${where.length ? `where ${where.join(" and ")}` : ""} order by
       case when coalesce(c.state, 'open') = 'resolved' then 1 else 0 end,
       d.created_at asc`,
    args,
  );
  return r.rows.map(shapeCase);
}

export async function adminCase(id: string): Promise<AdminCase | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(`${CASE_SQL} where d.dispute_id = $1`, [id]);
  return r.rows[0] ? shapeCase(r.rows[0]) : null;
}

/** Both sides of the case, in the order they were written. */
export async function caseThread(id: string) {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select e.event_id, e.author_id, e.kind, e.body, e.photos, e.created_at, u.name
       from dispute_events e
       left join users u on u.user_id = e.author_id
      where e.dispute_id = $1 order by e.created_at`,
    [id],
  );
  return r.rows.map((x: any) => ({
    id: x.event_id,
    by: x.name ?? x.author_id,
    byId: x.author_id,
    kind: x.kind,
    body: x.body,
    photos: Array.isArray(x.photos) ? x.photos : [],
    at: iso(x.created_at),
  }));
}

export async function caseCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {
    all: 0, open: 0, "awaiting-evidence": 0, escalated: 0, resolved: 0,
    members: 0, staff: 0,
  };
  const pool = storePool();
  if (!pool) return out;
  const r = await pool.query(
    `select coalesce(c.state, 'open') as state,
            (ru.role <> 'member' or au.role <> 'member') as involves_staff,
            count(*)::int n
       from disputes d
       left join conduct_cases c on c.dispute_id = d.dispute_id
       left join users ru on ru.user_id = d.raised_by
       left join users au on au.user_id = d.against_id
      group by 1, 2`,
  );
  for (const row of r.rows) {
    const n = Number(row.n);
    out.all += n;
    if (row.state in out) out[row.state] += n;
    if (row.involves_staff) out.staff += n;
    else out.members += n;
  }
  return out;
}

/* --------------------------------------------------------------------------
   Writing

   Every write upserts the conduct row: a dispute raised in the app has no
   conduct record until somebody here touches it, and requiring one to exist
   first would mean a case could not be worked until it had been worked.
   -------------------------------------------------------------------------- */

async function upsert(id: string, sets: string, args: any[]): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const exists = await pool.query("select 1 from disputes where dispute_id = $1", [id]);
  if (!exists.rowCount) return false;
  await pool.query(
    `insert into conduct_cases (dispute_id) values ($1) on conflict (dispute_id) do nothing`,
    [id],
  );
  await pool.query(
    `update conduct_cases set ${sets}, updated_at = now() where dispute_id = $1`,
    [id, ...args],
  );
  return true;
}

export const claimCase = (id: string, by: string) =>
  upsert(id, "claimed_by = $2, claimed_at = now()", [by]);

export const setCaseState = (id: string, state: CaseState) =>
  upsert(id, "state = $2", [state]);

/**
 * The decision.
 *
 * It names the person it lands on, because a case has two people in it and
 * "restricted" with no subject is not a record of anything. The standing
 * change itself is a separate write by the caller — one place enforces it.
 */
export const decideCase = (
  id: string,
  d: { outcome: Outcome; note: string; againstId: string; by: string },
) =>
  upsert(
    id,
    "state = 'resolved', outcome = $2, outcome_note = $3, against_id = $4, decided_by = $5, decided_at = now()",
    [d.outcome, d.note, d.againstId, d.by],
  );

/** A moderator's own line on the thread, written as the operator. */
export async function addCaseNote(id: string, by: string, body: string): Promise<boolean> {
  const pool = storePool();
  if (!pool) return false;
  const exists = await pool.query("select 1 from disputes where dispute_id = $1", [id]);
  if (!exists.rowCount) return false;
  await pool.query(
    `insert into dispute_events (event_id, dispute_id, author_id, kind, body)
     values ($1, $2, $3, 'status', $4)`,
    [`de_${randomUUID().slice(0, 12)}`, id, by, body],
  );
  return true;
}

/* --------------------------------------------------------------------------
   Row → console
   -------------------------------------------------------------------------- */

function shapeCase(r: any): AdminCase {
  const opened = r.created_at;
  return {
    id: r.dispute_id,
    kind: kindOf(r.reason),
    status: (isState(String(r.state ?? "open")) ? r.state ?? "open" : "open") as CaseState,
    opened: iso(opened),
    ageHours: Math.max(0, Math.round((Date.now() - new Date(opened).getTime()) / 3_600_000)),
    amount: Number(r.amount ?? 0),
    detail: r.detail ?? "",
    raisedBy: party(r.raised_by, r.raiser_name, r.raiser_identity, r.raiser_role_col, r.raiser_prior, r.raiser_since),
    against: party(r.against_id, r.against_name, r.against_identity, r.against_role_col, r.against_prior, r.against_since),
    involvesStaff: r.raiser_role_col !== "member" || r.against_role_col !== "member",
    raiserRole: r.raiser_role,
    listing: r.card_name
      ? {
          id: r.listing_id,
          card: r.card_name,
          setLine: [r.set_name, r.variant, r.card_number ? `#${String(r.card_number).replace(/^#/, "")}` : null]
            .filter(Boolean)
            .join(" · "),
          grader: r.grader ?? "Raw",
          grade: r.grade ?? "None",
          art: r.image_url ?? undefined,
        }
      : null,
    claimedBy: r.claimed_by ?? undefined,
    outcome: r.outcome ?? undefined,
    outcomeNote: r.outcome_note ?? undefined,
    decidedBy: r.decided_by ?? undefined,
    decidedAt: r.decided_at ? iso(r.decided_at) : undefined,
  };
}

function party(
  id: string,
  name: unknown,
  identity: unknown,
  role: unknown,
  prior: unknown,
  since: unknown,
): CaseParty {
  const n = String(name ?? "Unknown");
  const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const parts = n.trim().split(/\s+/).filter(Boolean);
  return {
    id,
    name: n,
    handle: slug ? `@${slug}` : `@${id}`,
    initials:
      ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase(),
    verified: identity === "Approved",
    staff: String(role ?? "member") !== "member",
    priorCases: Number(prior ?? 0),
    joined: since ? iso(since) : null,
  };
}

const iso = (d: any) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
