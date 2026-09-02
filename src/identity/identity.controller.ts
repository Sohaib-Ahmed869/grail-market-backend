import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { storePool } from "../cards.store.js";
import { HIGH_VALUE_AUD, requiredFor, tierOf, whatIsMissing, type TierInputs } from "./tiers.js";
import { createSession, diditConfigured, verifyWebhook, type DiditStatus } from "./didit.js";
import { callerId } from "../auth/auth.controller.js";
import { alreadySeen, applyStatus, readStatus, recordEvent } from "./store.js";

@Controller("identity")
export class IdentityController {
  /** Open a verification for a member.
   *
   *  The user id comes from our own record of who is calling, never from the
   *  request body — a client that could name its own user could verify itself
   *  as somebody else. There is no auth on this service yet, so for now it is
   *  taken from a header the app sets and this is marked as the thing to
   *  tighten the moment sessions exist. */
  @Post("session")
  async session(@Req() req: Request, @Body() body: { userId?: string }) {
    if (!diditConfigured()) {
      return { error: "identity-unconfigured", message: "DIDIT_API_KEY is not set" };
    }
    // The signed token, never a header the caller filled in. An app that can
    // name its own user can verify itself as somebody else.
    const userId = callerId(req);
    if (!userId) return { error: "unauthenticated", message: "Sign in first." };

    try {
      const s = await createSession(userId);
      await applyStatus(userId, "Not Started", s.sessionId);
      // token for the native SDK; url is the hosted fallback. The API key is
      // not in either.
      return { sessionId: s.sessionId, token: s.token, url: s.url };
    } catch (e: any) {
      console.error("[identity] session create failed:", e?.message);
      return { error: "session-failed", message: "Could not start verification." };
    }
  }

  /** Where this member stands. */
  /** The tier, and what stands between this person and the next one.
   *
   *  Computed from the identity row, the subscription and the sales history
   *  rather than stored: a stored tier is a copy of facts that live elsewhere,
   *  and the copy is wrong the moment any of them changes. */
  @Get("tier/:userId")
  async tier(@Param("userId") userId: string) {
    const pool = storePool();
    const row = await readStatus(userId);

    let inputs: TierInputs = {
      phoneVerified: false, hasPaymentInstrument: false,
      identityStatus: row?.status ?? null, completedSales: 0, addressVerified: false,
    };

    if (pool) {
      const r = await pool.query(
        `select
           (select phone is not null from users where user_id = $1) as has_phone,
           (select exists (select 1 from subscriptions
                            where user_id = $1 and status in ('active','trialing'))) as has_plan,
           (select count(*)::int from listings
             where seller_id = $1 and status = 'sold') as sold`,
        [userId],
      );
      const x = r.rows[0] ?? {};
      inputs = {
        ...inputs,
        // The phone is collected at sign-up and confirmed by OTP. That check
        // is stubbed in development, so this reflects "we hold a number",
        // which is what the column can honestly claim today.
        phoneVerified: Boolean(x.has_phone),
        hasPaymentInstrument: Boolean(x.has_plan),
        completedSales: x.sold ?? 0,
      };
    }

    const tier = tierOf(inputs);
    return {
      userId,
      tier,
      identityStatus: inputs.identityStatus ?? "Not Started",
      highValueThresholdAud: HIGH_VALUE_AUD,
      have: {
        phone: inputs.phoneVerified,
        payment: inputs.hasPaymentInstrument,
        identity: inputs.identityStatus === "Approved",
        address: inputs.addressVerified,
        completedSales: inputs.completedSales,
      },
      gates: {
        offer: { need: requiredFor("offer"), ok: tier >= requiredFor("offer"),
                 missing: whatIsMissing(tier, requiredFor("offer"), inputs) },
        sell: { need: requiredFor("sell"), ok: tier >= requiredFor("sell"),
                missing: whatIsMissing(tier, requiredFor("sell"), inputs) },
        sellHighValue: {
          need: requiredFor("sell-high-value"),
          ok: tier >= requiredFor("sell-high-value"),
          missing: whatIsMissing(tier, requiredFor("sell-high-value"), inputs),
        },
      },
    };
  }

  @Get("status/:userId")
  async status(@Param("userId") userId: string) {
    const row = await readStatus(userId);
    return row ?? { user_id: userId, status: "Not Started", verified_at: null };
  }

  /** Didit's decision.
   *
   *  This, not the app, is what makes someone verified. The client's callback
   *  says only that a person finished the flow — it does not say they passed,
   *  and it arrives from a device we do not control. */
  @Post("webhook")
  @HttpCode(200)
  async webhook(@Req() req: Request) {
    const raw = (req as any).rawBody as string | undefined;
    if (!raw) {
      console.error("[identity] webhook has no raw body — signature cannot be checked");
      return "ok";
    }

    const v = verifyWebhook(
      raw,
      String(req.header("x-signature-v2") ?? ""),
      String(req.header("x-timestamp") ?? ""),
    );
    if (!v.ok) {
      console.warn(`[identity] webhook rejected: ${v.why}`);
      // 200 anyway: a rejected delivery is not a server fault, and returning
      // 5xx would have Didit retry something that can never verify.
      return "ok";
    }

    const e = JSON.parse(raw) as {
      event_id: string; session_id: string; status: DiditStatus;
      vendor_data: string; decision?: unknown;
    };

    if (await alreadySeen(e.event_id)) return "ok";

    await recordEvent({
      eventId: e.event_id, userId: e.vendor_data, sessionId: e.session_id ?? null,
      status: e.status, decision: e.decision ?? null,
    });
    await applyStatus(e.vendor_data, e.status, e.session_id ?? null);
    console.log(`[identity] ${e.vendor_data} -> ${e.status}`);
    return "ok";
  }
}
