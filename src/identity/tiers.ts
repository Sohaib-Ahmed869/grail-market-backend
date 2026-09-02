// Verification tiers.
//
// From the scope document: access steps up with the value at stake, so
// friction lands only where risk justifies it.
//
//   0  Browse            email and phone
//   1  Low-value trade   + a payment instrument (a plan counts: it is a card
//                          on file with Stripe, which is the same evidence)
//   2  Standard sell     + government ID, selfie, liveness
//   3  High-value        + video, address, trading history
//
// Tier is computed, never stored. A stored tier is a copy of facts that live
// elsewhere — the identity row, the subscription, the sales history — and the
// copy goes stale the moment any of them changes. Deriving it means the
// answer cannot disagree with its own inputs.

export type Tier = 0 | 1 | 2 | 3;

export type TierInputs = {
  /** email is implied by having an account at all */
  phoneVerified: boolean;
  /** an active plan means a card on file with Stripe */
  hasPaymentInstrument: boolean;
  identityStatus: string | null;
  /** Tier 3 is earned, not bought: the extra checks plus a record of
   *  completed trades. Without the history it is just a bigger form. */
  completedSales: number;
  addressVerified: boolean;
};

/** The threshold above which a sale needs Tier 3, in AUD.
 *  Operator-tunable per the scope document; this is the recommended default. */
export const HIGH_VALUE_AUD = Number(process.env.HIGH_VALUE_THRESHOLD_AUD ?? 2000);

/** Completed sales needed before Tier 3 is available. */
const TIER3_SALES = Number(process.env.TIER3_MIN_SALES ?? 3);

export function tierOf(i: TierInputs): Tier {
  const idOk = i.identityStatus === "Approved";
  if (idOk && i.addressVerified && i.completedSales >= TIER3_SALES) return 3;
  if (idOk) return 2;
  if (i.phoneVerified && i.hasPaymentInstrument) return 1;
  return 0;
}

export type Gate =
  | "browse" | "watch" | "post"        // tier 0
  | "buy" | "offer"                     // tier 1
  | "sell"                              // tier 2
  | "sell-high-value";                  // tier 3

const REQUIRED: Record<Gate, Tier> = {
  browse: 0, watch: 0, post: 0,
  buy: 1, offer: 1,
  sell: 2,
  "sell-high-value": 3,
};

export const requiredFor = (gate: Gate): Tier => REQUIRED[gate];

/** What a person must do next to pass a gate — the sentence the app shows.
 *
 *  Named per tier rather than "verify your identity", because the four steps
 *  are genuinely different actions and telling someone to "verify" when they
 *  already have is how a gate becomes a dead end. */
export function whatIsMissing(
  current: Tier, needed: Tier, i?: TierInputs,
): string | null {
  if (current >= needed) return null;

  // One entry per TIER, not per requirement. The first version had four
  // strings for three tiers — because tier 1 needs two things and each got
  // its own slot — which shifted every message after it by one, so someone
  // short of the ID check was told to add a payment method.
  if (needed === 1) {
    if (i && i.phoneVerified && !i.hasPaymentInstrument) {
      return "Add a payment method — choosing a plan does that.";
    }
    if (i && !i.phoneVerified && i.hasPaymentInstrument) {
      return "Confirm your phone number.";
    }
    return "Confirm your phone number and add a payment method.";
  }
  if (needed === 2) {
    return "Pass the ID check: a document, a selfie and a liveness test.";
  }
  return `Tier 3 needs an address check and ${TIER3_SALES} completed sales. `
    + `It unlocks selling above A$${HIGH_VALUE_AUD.toLocaleString()}.`;
}

/** Does this listing price need the high-value tier? */
export const needsHighValue = (priceAud: number) => priceAud >= HIGH_VALUE_AUD;
