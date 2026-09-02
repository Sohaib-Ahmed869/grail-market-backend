import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { awaitingRating, rate, reputationFor } from "./store.js";

@Controller("ratings")
export class RatingsController {
  /** Deals waiting to be rated — the prompt list on the profile. */
  @Get("pending")
  async pending(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    return { deals: await awaitingRating(me) };
  }

  /** Anyone's public reputation. */
  @Get(":userId")
  async of(@Param("userId") userId: string) {
    return reputationFor(userId);
  }

  @Post()
  async leave(@Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", message: "Sign in to rate." };
    if (!b?.listingId) return { error: "invalid", message: "Which deal?" };
    const r = await rate(String(b.listingId), me, Number(b.stars), b.comment ?? null);
    return r.ok ? { ratingId: r.ratingId } : { error: r.why, message: r.message };
  }
}
