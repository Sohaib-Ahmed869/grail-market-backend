import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { gradedPricesFor } from "../scans/pricing.js";
import { registerToken, forgetToken } from "../push/store.js";
import { addWatch, listWatches, removeWatch, setAlert, sweep } from "./sweep.js";

@Controller()
export class WatchlistController {
  /** What someone is following, priced now.
   *
   *  Values are recomputed on read for the same reason the collection's are:
   *  a number written at the moment of adding is wrong by the next morning,
   *  and this list exists precisely because the number moves. */
  @Get("watchlist")
  async list(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };

    const rows = await listWatches(me);
    const items = await Promise.all(rows.map(async (w: any) => {
      let value: number | null = null;
      try {
        const p = await gradedPricesFor({
          catalogId: w.catalog_id, name: w.card_name,
          number: w.card_number, setName: w.set_name,
        });
        value = w.grader && w.grade
          ? p.byGrader?.[w.grader]?.[String(w.grade)]?.price ?? null
          : p.rawUsd ?? null;
      } catch { value = null; }

      const base = w.baseline == null ? null : Number(w.baseline);
      return {
        watchId: w.watch_id, catalogId: w.catalog_id, cardName: w.card_name,
        setName: w.set_name, cardNumber: w.card_number, imageUrl: w.image_url,
        grader: w.grader, grade: w.grade,
        alertPct: w.alert_pct == null ? null : Number(w.alert_pct),
        alertDir: w.alert_dir,
        value,
        // movement since the last thing we told them, which is what the
        // alert is measured against — not since they added it
        since: base != null && value != null ? ((value - base) / base) * 100 : null,
        baseline: base,
        addedAt: w.added_at,
      };
    }));

    return { watches: items, priced: items.filter((i) => i.value != null).length };
  }

  @Post("watchlist")
  async add(@Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", message: "Sign in to follow a card." };
    if (!b?.cardName) return { error: "invalid", message: "A card is required." };
    const id = await addWatch({
      userId: me, catalogId: b.catalogId ?? null, cardName: String(b.cardName),
      setName: b.setName ?? null, cardNumber: b.cardNumber ?? null,
      imageUrl: b.imageUrl ?? null, grader: b.grader ?? null,
      grade: b.grade != null ? String(b.grade) : null,
      alertPct: b.alertPct == null ? 10 : Number(b.alertPct),
      alertDir: b.alertDir ?? "any",
    });
    return id ? { watchId: id } : { error: "no-store" };
  }

  @Post("watchlist/:watchId/alert")
  async alert(@Param("watchId") watchId: string, @Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const pct = b?.alertPct == null ? null : Number(b.alertPct);
    const ok = await setAlert(watchId, me, pct, String(b?.alertDir ?? "any"));
    return ok ? { alertPct: pct, alertDir: b?.alertDir ?? "any" } : { error: "not-found" };
  }

  @Delete("watchlist/:watchId")
  async remove(@Param("watchId") watchId: string, @Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    return { removed: await removeWatch(watchId, me) };
  }

  // ---- push -----------------------------------------------------------------

  @Post("push/register")
  async register(@Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    if (!b?.token) return { error: "invalid" };
    await registerToken(String(b.token), me, b.platform ?? null);
    return { ok: true };
  }

  @Post("push/forget")
  async forget(@Body() b: any) {
    if (b?.token) await forgetToken(String(b.token));
    return { ok: true };
  }

  /** Run the alert sweep. Called by the scheduler, not by a person — it is
   *  here rather than in a cron binary so the same deployment runs it. */
  @Post("watchlist/sweep")
  async runSweep(@Req() req: Request, @Body() b: any) {
    const secret = process.env.SWEEP_SECRET;
    if (!secret || b?.secret !== secret) return { error: "forbidden" };
    return sweep();
  }
}
