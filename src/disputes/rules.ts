// When a deal goes wrong, and what can happen next.
//
// Pure, and away from the database, for the same reason the rating rules are:
// these decide whether someone gets their money back, and that argument
// should be readable in one screen and testable without Postgres.
//
// The shape of the problem: a dispute is raised by one party, the other gets
// to answer, and somebody neutral decides. Everything here is about keeping
// those three roles honest — nobody argues with themselves, nobody raises a
// dispute about a deal they were not in, and nothing reopens once it is
// settled.

export const REASONS = [
  { code: "not-received",   label: "It never arrived",            side: "buyer" },
  { code: "not-as-described", label: "Not what was listed",       side: "buyer" },
  { code: "damaged",        label: "Damaged in transit",          side: "buyer" },
  { code: "counterfeit",    label: "I think it's a fake",         side: "buyer" },
  { code: "wrong-item",     label: "The wrong card arrived",      side: "buyer" },
  { code: "not-paid",       label: "The buyer never paid",        side: "seller" },
  { code: "returned-empty", label: "It came back wrong or empty", side: "seller" },
  { code: "other",          label: "Something else",              side: "both" },
] as const;

export type ReasonCode = (typeof REASONS)[number]["code"];
export const isReason = (c: string): c is ReasonCode =>
  REASONS.some((r) => r.code === c);

/** open -> answered -> resolved. `withdrawn` is the raiser changing their
 *  mind, which is a different ending from a decision and is recorded as one. */
export type Status = "open" | "answered" | "resolved" | "withdrawn";

/** What a resolution actually says happened. Deliberately small: anything
 *  finer is a sentence in the outcome note, not a new code to reason about. */
export const OUTCOMES = [
  "refund-full", "refund-partial", "return-and-refund",
  "no-action", "in-buyer-favour", "in-seller-favour",
] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const isOutcome = (o: string): o is Outcome =>
  (OUTCOMES as readonly string[]).includes(o);

export type Deal = {
  sellerId: string;
  buyerId: string | null;
  listingStatus: string;
  offerStatus: string;
  /** an open or settled dispute already on this listing */
  existingStatus: Status | null;
};

export type RaiseVerdict =
  | { ok: true; against: string; role: "buyer" | "seller" }
  | {
      ok: false;
      why: "not-party" | "self" | "no-deal" | "already-open" | "already-resolved" | "bad-reason";
    };

/** A window, so a dispute is about a recent trade rather than an argument
 *  reopened two years later when nobody has the packaging any more. */
export const RAISE_WINDOW_DAYS = 45;

export function canRaise(
  userId: string,
  d: Deal,
  reason: string,
  soldDaysAgo: number | null = 0,
): RaiseVerdict {
  if (!isReason(reason)) return { ok: false, why: "bad-reason" };
  if (d.buyerId && d.sellerId === d.buyerId) return { ok: false, why: "self" };

  const isSeller = userId === d.sellerId;
  const isBuyer = d.buyerId != null && userId === d.buyerId;
  if (!isSeller && !isBuyer) return { ok: false, why: "not-party" };

  // A dispute needs a trade behind it. Unlike a rating, "sold" alone is not
  // enough — an accepted offer is what names the other party, and without one
  // there is nobody for the dispute to be against.
  const traded = d.offerStatus === "accepted" && d.listingStatus === "sold";
  if (!traded || !d.buyerId) return { ok: false, why: "no-deal" };

  if (d.existingStatus === "open" || d.existingStatus === "answered") {
    return { ok: false, why: "already-open" };
  }
  if (d.existingStatus === "resolved") return { ok: false, why: "already-resolved" };
  // A withdrawn dispute may be raised again — withdrawing is often "let me
  // talk to them first", and that conversation sometimes fails.

  if (soldDaysAgo != null && soldDaysAgo > RAISE_WINDOW_DAYS) {
    return { ok: false, why: "no-deal" };
  }

  return {
    ok: true,
    against: isSeller ? d.buyerId : d.sellerId,
    role: isSeller ? "seller" : "buyer",
  };
}

export type Dispute = {
  raisedBy: string;
  against: string;
  status: Status;
};

/** Who may add to the thread. Both parties, while it is live — and nobody
 *  once it is settled, because a resolved dispute is a record. */
export function canComment(userId: string, d: Dispute): boolean {
  if (d.status === "resolved" || d.status === "withdrawn") return false;
  return userId === d.raisedBy || userId === d.against;
}

/** Only the person who raised it, and only while it is live. The other party
 *  withdrawing it would be the accused dismissing the accusation. */
export function canWithdraw(userId: string, d: Dispute): boolean {
  return userId === d.raisedBy && (d.status === "open" || d.status === "answered");
}

/** Neither party. A dispute decided by one of the two people arguing is not a
 *  decision, and the caller is expected to have checked for staff — this
 *  states the half of the rule that does not depend on who is staff. */
export function canResolve(userId: string, d: Dispute): boolean {
  if (d.status === "resolved" || d.status === "withdrawn") return false;
  return userId !== d.raisedBy && userId !== d.against;
}

/** The status after a message from `userId`. The first reply from the accused
 *  is what moves a dispute out of "open" — it is the difference between "no
 *  answer yet" and "these two disagree", and only the first one counts. */
export function statusAfterComment(userId: string, d: Dispute): Status {
  if (d.status === "open" && userId === d.against) return "answered";
  return d.status;
}
