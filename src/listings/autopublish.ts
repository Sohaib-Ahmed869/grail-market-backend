// Which listings go live without a person looking, and why the rest wait.
//
// Ahmed, 11 September: every listing passes the automatic checks; listings
// under roughly A$2,500 publish automatically; above that a person at
// GrailMarket approves them first. The value is a setting, not a constant,
// because he intends to raise it once the automatic route has proved itself.
//
// GM001-34 asks for the automatic step to be WRITTEN DOWN before anyone
// relies on it, because "automatic verification" was never defined on the
// call and cannot mean proof that a card is genuine — there is no remote way
// to establish that for an ungraded card. This function is that definition.
// Every check below is something we can actually test from what a listing
// carries; none of them is a claim about the card's authenticity.
//
//   1. under the auto-publish value
//   2. matched to a catalogue card — we know what it claims to be
//   3. priced within reason of that card's market value — a Charizard at
//      A$40 or a common at A$4,000 is somebody's mistake or somebody's scam
//   4. every required angle photographed
//   5. a certificate number, when the card is graded
//   6. a seller in good standing whose identity check passed
//
// Anything that fails one check goes to the review queue exactly as every
// listing did before, with the failed checks attached so the reviewer knows
// what to look at.

export type AutoPublishInput = {
  price: number;
  marketValue: number | null;
  catalogId: string | null;
  photoVerified: boolean;
  graded: boolean;
  certNumber: string | null;
  sellerStanding: string | null;
  identityApproved: boolean;
};

export type AutoPublishRules = { enabled: boolean; below: number };

export type AutoPublishDecision = { publish: boolean; held: string[] };

/** How far from market value a price may sit and still publish itself. */
export const PRICE_BAND = { low: 0.4, high: 2.5 } as const;

export function autoPublish(l: AutoPublishInput, rules: AutoPublishRules): AutoPublishDecision {
  const held: string[] = [];
  if (!rules.enabled) held.push("Automatic publishing is switched off");
  if (!(l.price < rules.below)) held.push(`Asking A$${fmt(l.price)} is at or above the A$${fmt(rules.below)} auto-publish value`);
  if (!l.catalogId) held.push("Not matched to a catalogue card");
  if (l.marketValue == null || !(l.marketValue > 0)) {
    held.push("No market value to check the price against");
  } else {
    const ratio = l.price / l.marketValue;
    if (ratio < PRICE_BAND.low) held.push(`Priced at ${pct(ratio)} of market value — unusually low`);
    if (ratio > PRICE_BAND.high) held.push(`Priced at ${pct(ratio)} of market value — unusually high`);
  }
  if (!l.photoVerified) held.push("Not every required angle is photographed");
  if (l.graded && !l.certNumber) held.push("Graded card without a certificate number");
  if ((l.sellerStanding ?? "active") !== "active") held.push(`Seller standing is ${l.sellerStanding}`);
  if (!l.identityApproved) held.push("Seller has not passed the identity check");
  return { publish: held.length === 0, held };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-AU");
const pct = (r: number) => `${Math.round(r * 100)}%`;
