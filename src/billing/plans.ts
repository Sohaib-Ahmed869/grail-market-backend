/** The plans, and every amount GrailMarket charges, in one place.
 *
 *  Confirmed by the client in their pricing brief of 1 September (GM001-32):
 *
 *    Free       one free active listing per VERIFIED seller, reusable when
 *               the listing closes. No subscription needed.
 *    Collector  A$19.99 a month or A$199.99 a year, 25 active listings.
 *    Dealer     A$69.99 a month or A$699.99 a year, unlimited under a Fair
 *               Use Policy.
 *    Extra active listing A$5.99 each.
 *    Priority Boost A$4.99 / 48h, Featured A$9.99 / 7d, Spotlight A$19.99 / 7d.
 *    No commission on the sale. No free trial. A subscription is optional.
 *
 *  OPEN, and deliberately not guessed: whether these amounts are GST
 *  inclusive. They are recorded here exactly as the client wrote them. If the
 *  answer is "exclusive", every figure in PRICING moves and nothing else does.
 *
 *  Prices are CHARGED by Stripe — a price id, not a number — because a figure
 *  typed into two systems disagrees with itself the first time anybody edits
 *  one. The cents below are the configuration Stripe is set up from
 *  (`npm run stripe:setup`) and the display fallback before it has been; the
 *  plans endpoint always shows Stripe's own figure where Stripe has one.
 *
 *  STORE BILLING, not built yet. The client instructed Apple and Google store
 *  billing, with web selling deferred; it is blocked on the store accounts
 *  (the Apple developer account in particular). When it lands, each store
 *  carries eight products, sixteen across both:
 *    auto-renewing subscriptions  collector.month, collector.year,
 *                                 dealer.month, dealer.year
 *    consumables                  listing.extra, boost.priority,
 *                                 boost.featured, boost.spotlight
 *  Every one of them maps to an entry in PRICING, which is why the amounts
 *  live here rather than beside the Stripe calls. Net of GST and the 15%
 *  store commission, A$19.99 returns A$15.45 and A$69.99 returns A$54.08.
 */
export const PRICING = {
  free: { listings: 1 },
  collector: { monthCents: 1999, yearCents: 19999, listings: 25 },
  dealer: { monthCents: 6999, yearCents: 69999, listings: null },
  /** Blocked on the client: is a paid A$5.99 slot single-use or reusable
   *  when that listing closes? The amount is configured; nothing sells it. */
  extraListingCents: 599,
  boosts: {
    priority: { cents: 499, hours: 48 },
    featured: { cents: 999, hours: 7 * 24 },
    spotlight: { cents: 1999, hours: 7 * 24 },
  },
} as const;

export type PlanId = "free" | "collector" | "dealer" | "starter";
export type Interval = "month" | "year";

export type Plan = {
  id: PlanId;
  name: string;
  blurb: string;
  /** Monthly, in AUD cents. Display fallback only; Stripe holds the charge. */
  amountCents: number;
  /** Yearly, in AUD cents. Null where the plan has no annual price. */
  annualCents: number | null;
  /** Active listings allowed at once. null = no ceiling. */
  listings: number | null;
  perks: string[];
  popular?: boolean;
  /** No subscription: granted to any seller whose identity check passed. */
  free?: boolean;
  /** Unlimited, subject to the Fair Use Policy. */
  fairUse?: boolean;
  /** Still resolvable so an old subscription row keeps working, never offered. */
  legacy?: boolean;
  /** Stripe price ids, from the environment. Empty for Free. */
  priceEnv: string;
  annualPriceEnv: string;
};

export const PLANS: Plan[] = [
  {
    id: "free", name: "Free", blurb: "One active listing, for verified sellers.",
    amountCents: 0, annualCents: null, listings: PRICING.free.listings, free: true,
    perks: [
      "One active listing at a time",
      "Reusable when that listing closes",
      "Needs a passed identity check",
      "Unlimited price checks",
    ],
    priceEnv: "", annualPriceEnv: "",
  },
  {
    id: "collector", name: "Collector", blurb: "Up to 25 active listings.",
    amountCents: PRICING.collector.monthCents, annualCents: PRICING.collector.yearCents,
    listings: PRICING.collector.listings, popular: true,
    perks: ["25 active listings", "Unlimited price checks", "Save a collection"],
    priceEnv: "STRIPE_PRICE_COLLECTOR", annualPriceEnv: "STRIPE_PRICE_COLLECTOR_ANNUAL",
  },
  {
    id: "dealer", name: "Dealer", blurb: "Unlimited active listings.",
    amountCents: PRICING.dealer.monthCents, annualCents: PRICING.dealer.yearCents,
    listings: PRICING.dealer.listings, fairUse: true,
    perks: [
      "Everything in Collector",
      "Unlimited active listings, under the Fair Use Policy",
    ],
    priceEnv: "STRIPE_PRICE_DEALER", annualPriceEnv: "STRIPE_PRICE_DEALER_ANNUAL",
  },
];

/** Plans a member pays Stripe for. */
export const PAID_PLANS: Plan[] = PLANS.filter((p) => !p.free);

/** Plans nobody can choose any more but an old row may still name. There are
 *  no Starter subscribers today; keeping it resolvable means one appearing
 *  from an old test account or a replayed webhook cannot fall through to "no
 *  plan" or, worse, to unlimited. */
export const LEGACY_PLANS: Plan[] = [
  {
    id: "starter", name: "Starter", blurb: "One live listing at a time.",
    amountCents: 500, annualCents: null, listings: 1, legacy: true,
    perks: ["One live listing"],
    priceEnv: "STRIPE_PRICE_STARTER", annualPriceEnv: "",
  },
];

export const FREE_PLAN: Plan = PLANS.find((p) => p.free)!;

export const findPlan = (id: string) =>
  PLANS.find((p) => p.id === id) ?? LEGACY_PLANS.find((p) => p.id === id) ?? null;

export const priceIdFor = (p: Plan, interval: Interval = "month") =>
  (interval === "year" ? (p.annualPriceEnv ? process.env[p.annualPriceEnv] : "") : (p.priceEnv ? process.env[p.priceEnv] : "")) ?? "";
