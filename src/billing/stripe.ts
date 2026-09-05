import { createHmac, timingSafeEqual } from "node:crypto";
import { findPlan, priceIdFor } from "./plans.js";
import { livePriceFor } from "./liveprice.js";

// Stripe, over plain HTTP rather than the SDK.
//
// Two calls and one signature check is the whole surface, and a dependency
// that ships a hundred files to make three requests is a dependency to
// upgrade forever.

const API = "https://api.stripe.com/v1";

export const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY);

/** Form-encode the way Stripe expects: bracketed paths, not JSON. */
function form(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

/** Open a hosted Checkout for one member and one plan.
 *
 *  `client_reference_id` is our user id. It comes back on the webhook and is
 *  the only thing tying a payment to a person, so it is ours and never
 *  something the client supplied.
 *
 *  Both return URLs are deep links into the app. Stripe sends the browser
 *  there when the flow ends, which is what closes the sheet and hands control
 *  back — without them the member is left staring at a Stripe page with no way
 *  home but the back gesture. */
export async function createCheckout(opts: {
  userId: string; planId: string; returnBase: string;
  /**
   * The price to sell at, when the caller knows a newer one than the
   * environment names.
   *
   * The admin console can change a plan's price, and a Stripe price is
   * immutable — so that creates a NEW price id and the env var still names the
   * old one. Without this, every plan edit would appear to work and every new
   * subscription would quietly be sold at the previous figure.
   */
  priceId?: string;
}): Promise<{ url: string; id: string }> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");

  const plan = findPlan(opts.planId);
  if (!plan) throw new Error(`unknown plan: ${opts.planId}`);
  // The price Stripe currently sells this product at, which is not necessarily
  // the id in the environment: editing a price archives it and creates a new
  // one, and Stripe rejects an archived price with "The price specified is
  // inactive". Falling back to the pinned id keeps this working when Stripe
  // cannot be reached to resolve anything better.
  const live = await livePriceFor(plan);
  const price = live?.priceId ?? priceIdFor(plan);
  if (!price) throw new Error(`${plan.priceEnv} is not set`);

  const res = await fetch(`${API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form({
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": 1,
      client_reference_id: opts.userId,
      "metadata[user_id]": opts.userId,
      "metadata[plan_id]": plan.id,
      // subscription_data metadata survives onto the subscription itself, so a
      // later renewal webhook still knows who and which plan
      "subscription_data[metadata][user_id]": opts.userId,
      "subscription_data[metadata][plan_id]": plan.id,
      success_url: `${opts.returnBase}?status=done&plan=${plan.id}`,
      cancel_url: `${opts.returnBase}?status=cancelled`,
    }),
  });

  if (!res.ok) {
    throw new Error(`stripe checkout failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const s = (await res.json()) as { id: string; url: string };
  return { id: s.id, url: s.url };
}

// ---- webhook verification ---------------------------------------------------

export type StripeVerify =
  | { ok: true }
  | { ok: false; why: "no-secret" | "malformed" | "stale" | "bad-signature" };

/** Is this really Stripe, and recent?
 *
 *  Stripe signs `timestamp.rawBody`, and the header carries several schemes at
 *  once — v1 is the HMAC one. The timestamp is inside the signed string, so an
 *  attacker cannot backdate a captured event; the separate freshness check
 *  stops them replaying it unchanged. */
export function verifyStripe(
  rawBody: string, header: string, nowMs = Date.now(), toleranceSec = 300,
): StripeVerify {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { ok: false, why: "no-secret" };

  const parts = Object.fromEntries(
    (header ?? "").split(",").map((p) => p.split("=", 2) as [string, string]),
  );
  const ts = Number(parts.t);
  const sig = parts.v1;
  if (!ts || !sig) return { ok: false, why: "malformed" };
  if (Math.abs(nowMs / 1000 - ts) > toleranceSec) return { ok: false, why: "stale" };

  const expected = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`, "utf8")
    .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, why: "bad-signature" };
  return { ok: true };
}

/* ==========================================================================
   Products and prices — what the admin console edits

   Two rules of Stripe's data model shape everything below, and both are
   surprising the first time:

   1. A Price is IMMUTABLE. Its `unit_amount` cannot be edited, ever. Changing
      what a plan costs means creating a NEW price on the same product and
      pointing the product at it. There is no update-in-place to write.

   2. Creating that new price does NOT re-price anybody already subscribed.
      Existing subscriptions keep the price they were created with until each
      one is migrated. The console has to say so out loud, because "changed the
      price" reads as "everybody now pays this" and it does not mean that.

   The product's name and description ARE mutable, so those are a plain update.
   ========================================================================== */

async function call<T>(
  path: string,
  init?: { method?: string; body?: Record<string, string | number | undefined> },
): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");

  const res = await fetch(`${API}/${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init?.body ? form(init.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    /* Stripe's own message is the useful half — "No such price: price_123" is
       something an operator can act on, where "stripe failed (400)" is not. */
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      if (j?.error?.message) detail = j.error.message;
    } catch {
      /* not JSON: the raw body is the best we have */
    }
    throw new Error(detail);
  }
  return JSON.parse(text) as T;
}

export type StripePrice = {
  id: string;
  product: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  recurring: { interval: string; interval_count: number } | null;
};

export type StripeProduct = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  default_price?: string | { id: string } | null;
};

export const getPrice = (id: string) => call<StripePrice>(`prices/${encodeURIComponent(id)}`);

export const getProduct = (id: string) =>
  call<StripeProduct>(`products/${encodeURIComponent(id)}`);

/** Name and description. Both are mutable, unlike everything about a price. */
export const updateProduct = (id: string, patch: { name?: string; description?: string }) =>
  call<StripeProduct>(`products/${encodeURIComponent(id)}`, {
    method: "POST",
    body: { name: patch.name, description: patch.description },
  });

/**
 * A new price on an existing product.
 *
 * `unit_amount` is in the currency's smallest unit — cents for AUD — and the
 * console works in whole dollars, so the conversion happens exactly once, at
 * the caller. Passing dollars here would charge a hundredth of the intended
 * amount and look plausible on the way through.
 */
export const createPrice = (opts: {
  product: string;
  unitAmount: number;
  currency: string;
  interval: string;
}) =>
  call<StripePrice>("prices", {
    method: "POST",
    body: {
      product: opts.product,
      unit_amount: opts.unitAmount,
      currency: opts.currency.toLowerCase(),
      "recurring[interval]": opts.interval,
    },
  });

/** Point the product at a price, so new checkouts pick it up. */
export const setDefaultPrice = (product: string, price: string) =>
  call<StripeProduct>(`products/${encodeURIComponent(product)}`, {
    method: "POST",
    body: { default_price: price },
  });

/**
 * Retire the old price.
 *
 * Archived, never deleted — a price with subscriptions on it cannot be deleted
 * and should not be: the subscriptions still reference it, and the invoices
 * already raised against it have to keep resolving.
 */
export const archivePrice = (id: string) =>
  call<StripePrice>(`prices/${encodeURIComponent(id)}`, {
    method: "POST",
    body: { active: "false" },
  });
