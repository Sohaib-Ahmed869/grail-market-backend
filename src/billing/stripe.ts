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
