import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { photosConfigured, signUpload } from "../photos/s3.js";
import { REASONS } from "./rules.js";
import {
  addEvent, getDispute, myDisputes, raiseDispute, resolveDispute, withdrawDispute,
} from "./store.js";

@Controller("disputes")
export class DisputesController {
  /** The reason list, from the server, so the app and the web client cannot
   *  drift apart on codes the rules then refuse. */
  @Get("reasons")
  reasons() {
    return { reasons: REASONS };
  }

  @Get()
  async mine(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    return { disputes: await myDisputes(me) };
  }

  @Get(":id")
  async one(@Param("id") id: string, @Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const r = await getDispute(id, me);
    // Deliberately the same answer for "no such dispute" and "not yours", so
    // an id cannot be probed for existence.
    return r ?? { error: "not-found", message: "That dispute doesn't exist." };
  }

  @Post()
  async raise(
    @Req() req: Request,
    @Body() b: { listingId?: string; reason?: string; detail?: string; photos?: unknown },
  ) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    if (!b?.listingId) return { error: "invalid", message: "Which sale is this about?" };
    const r = await raiseDispute({
      listingId: String(b.listingId), userId: me, reason: String(b?.reason ?? ""),
      detail: b?.detail ?? null, photos: b?.photos,
    });
    return r.ok ? { disputeId: r.disputeId } : { error: r.why, message: r.message };
  }

  /** Signed URLs for evidence photographs. The bytes go straight to S3 — the
   *  API only signs, so six images do not occupy six request slots on the box
   *  that also runs the scan pipeline. */
  @Post(":id/photo-urls")
  async photoUrls(@Param("id") id: string, @Req() req: Request, @Body() b: { count?: number }) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    if (!photosConfigured()) {
      return { error: "photos-unconfigured", message: "Photo storage is not configured." };
    }
    // Only a party to the dispute, and getDispute already refuses anyone else.
    const d = await getDispute(id, me);
    if (!d) return { error: "not-found", message: "That dispute doesn't exist." };

    const n = Math.min(Math.max(Number(b?.count ?? 1), 1), 6);
    const uploads = await Promise.all(
      Array.from({ length: n }, (_, i) => signUpload(id, `evidence-${i}`, "image/jpeg", "disputes")),
    );
    return { uploads };
  }

  @Post(":id/reply")
  async reply(
    @Param("id") id: string, @Req() req: Request,
    @Body() b: { body?: string; photos?: unknown },
  ) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const r = await addEvent({ disputeId: id, userId: me, body: b?.body ?? null, photos: b?.photos });
    return r.ok ? { ok: true, status: r.status } : { error: "refused", message: r.message };
  }

  @Post(":id/withdraw")
  async withdraw(@Param("id") id: string, @Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const r = await withdrawDispute(id, me);
    return r.ok ? { ok: true } : { error: "refused", message: r.message };
  }

  /** Settling one. Neither party can reach this — `canResolve` refuses both —
   *  so in practice it is staff, once an admin role exists to name them. */
  @Post(":id/resolve")
  async resolve(
    @Param("id") id: string, @Req() req: Request,
    @Body() b: { outcome?: string; note?: string },
  ) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const r = await resolveDispute({
      disputeId: id, byUserId: me, outcome: String(b?.outcome ?? ""), note: b?.note ?? null,
    });
    return r.ok ? { ok: true } : { error: "refused", message: r.message };
  }
}
