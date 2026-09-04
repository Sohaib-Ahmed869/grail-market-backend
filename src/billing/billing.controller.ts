import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { PLANS, findPlan, type PlanId } from "./plans.js";
import { createCheckout, stripeConfigured, verifyStripe } from "./stripe.js";
import { callerId } from "../auth/auth.controller.js";
import { alreadySeen, applySubscription, readSubscription, recordEvent } from "./store.js";
import { livePriceId } from "../admin/commerce.store.js";

/** Where Stripe sends the browser when Checkout ends. A deep link, so the app
 *  comes back to the front rather than leaving the member on a web page. */
const RETURN = process.env.BILLING_RETURN_URL ?? "grailmarket://plans/done";

@Controller("billing")
export class BillingController {
  /** The plans, so the app renders one list rather than keeping its own copy
   *  that drifts from the prices actually charged. */
  @Get("plans")
  plans() {
    return {
      configured: stripeConfigured(),
      plans: PLANS.map(({ priceEnv, ...rest }) => rest),
    };
  }

  @Get("subscription/:userId")
  async subscription(@Param("userId") userId: string) {
    const row = await readSubscription(userId);
    return row ?? { user_id: userId, plan_id: null, status: "none" };
  }

  /** Start Checkout. Returns a URL for the app to open. */
  @Post("checkout")
  async checkout(@Req() req: Request, @Body() body: { planId?: string; userId?: string }) {
    if (!stripeConfigured()) {
      return { error: "billing-unconfigured", message: "STRIPE_SECRET_KEY is not set" };
    }
    // The signed token, never a header the caller filled in — otherwise
    // anyone could subscribe, or verify, as anyone.
    const userId = callerId(req);
    if (!userId) return { error: "unauthenticated", message: "Sign in first." };
    if (!findPlan(String(body?.planId))) {
      return { error: "bad-plan", message: "Unknown plan." };
    }
    try {
      const s = await createCheckout({
        userId,
        planId: String(body!.planId),
        returnBase: RETURN,
        /* Stripe's current price for this plan, which is not the environment
           variable once the console has edited one — a Stripe price is
           immutable, so an edit makes a new id and leaves the env var naming
           the old one. Falls back to the env var when nothing is cached. */
        priceId: await livePriceId(String(body!.planId)),
      });
      return { url: s.url, id: s.id };
    } catch (e: any) {
      console.error("[billing] checkout failed:", e?.message);
      return { error: "checkout-failed", message: "Could not start checkout." };
    }
  }

  /** Stripe's word on what was paid.
   *
   *  The app returning from Checkout proves the browser came back, nothing
   *  more — a member could land on the success URL without a card ever being
   *  charged. Entitlement is only ever written here. */
  @Post("webhook")
  @HttpCode(200)
  async webhook(@Req() req: Request) {
    const raw = (req as any).rawBody as string | undefined;
    if (!raw) {
      console.error("[billing] webhook has no raw body — signature cannot be checked");
      return "ok";
    }
    const v = verifyStripe(raw, String(req.header("stripe-signature") ?? ""));
    if (!v.ok) {
      console.warn(`[billing] webhook rejected: ${v.why}`);
      return "ok";
    }

    const e = JSON.parse(raw) as {
      id: string; type: string; data: { object: any };
    };
    if (await alreadySeen(e.id)) return "ok";

    const obj = e.data?.object ?? {};
    const userId: string | null =
      obj.client_reference_id ?? obj.metadata?.user_id ?? null;
    const planId = (obj.metadata?.plan_id ?? null) as PlanId | null;

    await recordEvent({ eventId: e.id, userId, type: e.type, payload: obj });

    if (userId) {
      switch (e.type) {
        case "checkout.session.completed":
          await applySubscription({
            userId, planId, status: "active",
            stripeSubId: obj.subscription ?? null, periodEnd: null,
          });
          break;
        case "customer.subscription.updated":
        case "customer.subscription.created":
          await applySubscription({
            userId, planId, status: String(obj.status ?? "active"),
            stripeSubId: obj.id ?? null,
            periodEnd: obj.current_period_end ? new Date(obj.current_period_end * 1000) : null,
          });
          break;
        case "customer.subscription.deleted":
          await applySubscription({
            userId, planId, status: "cancelled",
            stripeSubId: obj.id ?? null, periodEnd: null,
          });
          break;
        default:
          break; // logged above; nothing to apply
      }
      console.log(`[billing] ${userId} <- ${e.type}`);
    }
    return "ok";
  }
}
