import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { cardHistory, collectionHistory, marketIndex } from "./store.js";

@Controller("history")
export class HistoryController {
  /** One card at one grade, over time. The composite key is required in full:
   *  a grade without a grader is not a thing this system will price, and it is
   *  not a thing it will chart either. */
  @Get("card")
  async card(
    @Query("catalogId") catalogId?: string,
    @Query("grader") grader?: string,
    @Query("grade") grade?: string,
    @Query("qualifier") qualifier?: string,
    @Query("labelVariant") labelVariant?: string,
    @Query("days") days?: string,
  ) {
    if (!catalogId || !grader || !grade) {
      return { error: "invalid", message: "A card, a grading company and a grade." };
    }
    const n = Number(grade);
    if (!Number.isFinite(n)) return { error: "invalid", message: "That grade isn't a number." };

    const h = await cardHistory({
      catalogId, grader, grade: n,
      qualifier: qualifier ?? null, labelVariant: labelVariant ?? null,
      days: days ? Number(days) : undefined,
    });
    // Not an error. We have no history for most cards yet, and saying so is
    // the honest answer — a chart drawn from nothing would be a lie with axes.
    return h ?? { history: null, reason: "no-history" };
  }

  @Get("index")
  async index(@Query("days") days?: string) {
    const r = await marketIndex(days ? Number(days) : 90);
    return r ?? { points: [], basket: 0, reason: "no-history" };
  }

  @Get("collection")
  async collection(@Req() req: Request, @Query("days") days?: string) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const r = await collectionHistory(me, days ? Number(days) : 90);
    return r ?? { points: [], priced: 0, reason: "no-history" };
  }
}
