// Who may rate whom, and when.
//
// Pure, and separate from the database, because these are the rules that make
// a star count mean anything and they should be readable and testable without
// a Postgres connection. Every one of them exists to stop a rating being a
// claim about nothing.

export type Deal = {
  listingStatus: string;
  sellerId: string;
  buyerId: string;
  /** the offer that closed the deal */
  offerStatus: string;
  /** has this person already rated this deal */
  already: boolean;
};

export type Verdict =
  | { ok: true; counterparty: string; validStars: (n: number) => boolean }
  | { ok: false; why: "not-party" | "not-complete" | "already-rated" | "self";
      counterparty?: string; validStars: (n: number) => boolean };

const validStars = (n: number) => Number.isInteger(n) && n >= 1 && n <= 5;

export function canRate(userId: string, d: Deal): Verdict {
  if (d.sellerId === d.buyerId) return { ok: false, why: "self", validStars };

  const isSeller = userId === d.sellerId;
  const isBuyer = userId === d.buyerId;
  if (!isSeller && !isBuyer) return { ok: false, why: "not-party", validStars };

  const counterparty = isSeller ? d.buyerId : d.sellerId;

  // A rating has to attach to a trade that actually happened: the offer was
  // accepted AND the card was marked sold. Either alone is a deal that might
  // still fall over.
  const complete = d.offerStatus === "accepted" && d.listingStatus === "sold";
  if (!complete) return { ok: false, why: "not-complete", counterparty, validStars };

  if (d.already) return { ok: false, why: "already-rated", counterparty, validStars };

  return { ok: true, counterparty, validStars };
}
