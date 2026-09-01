/** The plans, in one place.
 *
 *  Prices live in Stripe — a price id, not a number — because a figure typed
 *  in two systems is a figure that disagrees with itself the first time
 *  anybody changes one. What lives here is the identity of each plan and what
 *  it entitles a member to, which is ours to enforce and not Stripe's.
 *
 *  `listings` is the enforcement point: it is what the sell flow checks before
 *  publishing, and the reason a plan exists at all.
 */
export type PlanId = "starter" | "collector" | "dealer";

export type Plan = {
  id: PlanId;
  name: string;
  blurb: string;
  /** monthly, in AUD cents — display only; Stripe holds the charged amount */
  amountCents: number;
  /** live listings allowed at once. null = no ceiling */
  listings: number | null;
  perks: string[];
  popular?: boolean;
  /** Stripe price id, from the dashboard. Empty until billing is configured. */
  priceEnv: string;
};

export const PLANS: Plan[] = [
  {
    id: "starter", name: "Starter", blurb: "One live listing at a time.",
    amountCents: 500, listings: 1,
    perks: ["One live listing", "Unlimited price checks", "Save a collection"],
    priceEnv: "STRIPE_PRICE_STARTER",
  },
  {
    id: "collector", name: "Collector", blurb: "Up to 10 live listings.",
    amountCents: 1000, listings: 10, popular: true,
    perks: ["Everything in Starter", "10 live listings", "Bulk scan up to 25 cards", "Priority support"],
    priceEnv: "STRIPE_PRICE_COLLECTOR",
  },
  {
    id: "dealer", name: "Dealer", blurb: "Unlimited listings + featured credits.",
    amountCents: 2000, listings: null,
    perks: ["Everything in Collector", "Unlimited live listings", "Featured listing credits"],
    priceEnv: "STRIPE_PRICE_DEALER",
  },
];

export const findPlan = (id: string) => PLANS.find((p) => p.id === id) ?? null;
export const priceIdFor = (p: Plan) => process.env[p.priceEnv] ?? "";
