// Who can do what in the admin console.
//
// Straight out of the "Roles & access" table in the feature set. Five staff
// roles, one of which — Support Tier 1 — is an outsourced desk, which is the
// whole reason this file exists as data rather than as a handful of `if`
// statements: "customer service can sit offshore" is a claim about what a
// scoped account CANNOT reach, and a claim like that has to be one list you
// can read in a minute.
//
// The console has the same table in its own `lib/data.ts` so it can hide the
// controls a role does not have. That copy is an interface, not a check. This
// one is the check.

export type Role = "member" | "tier-1" | "tier-2" | "moderator" | "trust-safety" | "owner";

export type Capability =
  | "dashboard.read"
  | "listings.review"
  | "members.read"
  | "members.act"
  | "team.read"
  | "conduct.decide"
  | "support.read"
  | "support.reply"
  | "id.exceptions"
  | "billing.read"
  | "pricing.read"
  | "reports.read"
  | "audit.read"
  | "announce.write"
  | "settings.write";

const ALL: Capability[] = [
  "dashboard.read", "listings.review", "members.read", "members.act", "team.read",
  "conduct.decide", "support.read", "support.reply", "id.exceptions", "billing.read",
  "pricing.read", "reports.read", "audit.read", "announce.write", "settings.write",
];

export const CAPABILITIES: Record<Role, Capability[]> = {
  /* Everyone who signs up. No admin surface at all — the console is not a
     thing an ordinary account can partly see. */
  member: [],

  /* The outsourced desk. Their own queue and nothing else: no ID data, no
     member records, no listing tools. */
  "tier-1": ["support.read", "support.reply"],

  /* The team lead. Escalations, plus listing and trade history for the ticket
     in hand — which the support endpoints supply per ticket, so it is still
     not a member directory of their own. */
  "tier-2": ["support.read", "support.reply"],

  /* Grail Market. The listing queue: approve, reject, ask for more photos.
     No billing, no ID. */
  moderator: ["dashboard.read", "listings.review", "members.read"],

  /* Grail Market. Reports, conduct outcomes, and the ID exceptions the
     provider could not settle. */
  "trust-safety": [
    "dashboard.read", "members.read", "members.act", "conduct.decide",
    "support.read", "support.reply", "id.exceptions", "reports.read", "audit.read",
  ],

  /* Everything, including subscriptions, the price engine and the audit log. */
  owner: ALL,
};

export const STAFF_ROLES: Role[] = ["tier-1", "tier-2", "moderator", "trust-safety", "owner"];

export const ROLE_LABEL: Record<Role, string> = {
  member: "Member",
  "tier-1": "Support · Tier 1",
  "tier-2": "Support · Tier 2",
  moderator: "Moderator",
  "trust-safety": "Trust & safety",
  owner: "Owner",
};

export const isRole = (v: unknown): v is Role =>
  typeof v === "string" && v in CAPABILITIES;

/** A role we do not recognise is a member, never an owner. A typo in the
 *  column must fail closed. */
export const roleOf = (v: unknown): Role => (isRole(v) ? v : "member");

export const isStaff = (role: Role) => role !== "member";

export const can = (role: Role, capability: Capability) =>
  CAPABILITIES[role].includes(capability);

export const capabilitiesOf = (role: Role) => CAPABILITIES[role];
