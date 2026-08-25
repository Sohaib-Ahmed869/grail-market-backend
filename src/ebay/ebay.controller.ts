import { Controller, Get, HttpCode, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";

// eBay Marketplace Account Deletion / Closure notifications.
//
// eBay marks a production keyset "Non Compliant" — and refuses to issue OAuth
// tokens for it — until this endpoint exists, answers their challenge, and is
// saved in the developer portal. It is a legal requirement, not an optional
// feature: when an eBay user deletes their account, every application holding
// their data must be told so it can erase it.
//
// Two behaviours are required at the SAME url:
//
//   GET  ?challenge_code=…   ownership check. Reply 200 with
//                            sha256(challengeCode + verificationToken + endpoint)
//   POST <notification body> a real deletion event. Acknowledge with 2xx fast;
//                            eBay retries and will disable the keyset if we
//                            keep failing.
//
// The hash inputs must be concatenated in exactly that order, and `endpoint`
// must be the exact URL string registered with eBay — scheme, host and path,
// no trailing slash, no query. Any mismatch and eBay rejects the challenge
// with a message that does not say why, so EBAY_DELETION_ENDPOINT is set
// explicitly rather than reconstructed from request headers (which sit behind
// a proxy in production and would give the internal host).

// Read lazily, not at module scope: main.ts loads .env at runtime but ES
// imports are hoisted above it, so anything captured at import time is empty.
const token = () => process.env.EBAY_VERIFICATION_TOKEN ?? "";
const endpoint = () => process.env.EBAY_DELETION_ENDPOINT ?? "";

@Controller("ebay/deletion")
export class EbayController {
  /** Ownership challenge. eBay calls this when you press Save, and again
   *  periodically to confirm the endpoint is still alive. */
  @Get()
  challenge(@Query("challenge_code") code: string | undefined, @Res() res: Response) {
    const TOKEN = token();
    const ENDPOINT = endpoint();
    if (!TOKEN || !ENDPOINT) {
      console.error(
        "[ebay] challenge received but EBAY_VERIFICATION_TOKEN / EBAY_DELETION_ENDPOINT are not set",
      );
      return res.status(500).json({ error: "endpoint not configured" });
    }
    if (!code) {
      return res.status(400).json({ error: "challenge_code is required" });
    }
    const challengeResponse = createHash("sha256")
      .update(code)
      .update(TOKEN)
      .update(ENDPOINT)
      .digest("hex");

    console.log(`[ebay] challenge answered for endpoint ${ENDPOINT}`);
    // eBay requires application/json and a 200; it reads only this field
    return res.status(200).json({ challengeResponse });
  }

  /** The real notification. eBay cares that we answer quickly and with a 2xx —
   *  anything else is retried and counts against the keyset's compliance. */
  @Post()
  @HttpCode(200)
  notify(@Req() req: Request) {
    const body = req.body as
      | {
          metadata?: { topic?: string };
          notification?: {
            notificationId?: string;
            data?: { username?: string; userId?: string; eiasToken?: string };
          };
        }
      | undefined;

    const d = body?.notification?.data;
    // Log the identifiers only. GrailCard stores card photographs and prices,
    // not eBay account data, so there is nothing keyed to an eBay user to
    // erase — but the event is recorded so that stays auditable.
    console.log(
      `[ebay] account deletion notice :: id=${body?.notification?.notificationId ?? "-"} ` +
        `topic=${body?.metadata?.topic ?? "-"} userId=${d?.userId ?? "-"} username=${d?.username ?? "-"}`,
    );
    return { acknowledged: true };
  }
}
