import { randomUUID } from "node:crypto";
import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { storePool } from "../cards.store.js";
import { callerId } from "../auth/auth.controller.js";
import { gradedPricesFor } from "../scans/pricing.js";

@Controller("collection")
export class CollectionController {
  /** What a member owns, valued at today's market rather than what they paid.
   *
   *  The figure is recomputed on read, not stored. A collection value written
   *  at the moment of adding is wrong by the next morning, and the whole
   *  reason to open the app twice a day is that the number moves. */
  @Get()
  async list(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const pool = storePool();
    if (!pool) return { entries: [], value: 0, cost: 0, gain: 0 };

    const r = await pool.query(
      "select * from collection where user_id = $1 order by added_at desc", [me],
    );

    const entries = await Promise.all(
      r.rows.map(async (e: any) => {
        let value: number | null = null;
        try {
          const p = await gradedPricesFor({
            catalogId: e.catalog_id, name: e.card_name,
            number: e.card_number, setName: e.set_name,
          });
          // Invariant 1: priced at its own grader and grade, never a
          // grade-only lookup and never another company's figure.
          value = e.grader && e.grade
            ? p.byGrader?.[e.grader]?.[String(e.grade)]?.price ?? null
            : p.rawUsd ?? null;
        } catch {
          value = null;   // a missing price is a blank, not a zero
        }
        return {
          entryId: e.entry_id, catalogId: e.catalog_id, cardName: e.card_name,
          setName: e.set_name, cardNumber: e.card_number, imageUrl: e.image_url,
          grader: e.grader, grade: e.grade, variant: e.variant ?? null,
          quantity: e.quantity ?? 1,
          paid: e.paid == null ? null : Number(e.paid),
          value, addedAt: e.added_at,
        };
      }),
    );

    // Quantity multiplies both sides. Four of the same card is four cards in
    // the total, and a paid price is per card — the earlier version counted
    // one of each and quietly under-reported anyone holding playsets.
    const value = entries.reduce((a, e) => a + (e.value ?? 0) * (e.quantity ?? 1), 0);
    const cost = entries.reduce((a, e) => a + (e.paid ?? 0) * (e.quantity ?? 1), 0);
    return {
      entries, value, cost, gain: value - cost,
      // Said plainly: a total that silently skips unpriced cards reads as the
      // whole collection and is not.
      priced: entries.filter((e) => e.value != null).length,
    };
  }

  @Post()
  async add(@Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", message: "Sign in to save a collection." };
    const pool = storePool();
    if (!pool) return { error: "no-store" };
    if (!b?.cardName) return { error: "invalid", message: "A card is required." };

    const id = `c_${randomUUID().slice(0, 12)}`;
    await pool.query(
      `insert into collection
         (entry_id, user_id, catalog_id, card_name, set_name, card_number,
          image_url, grader, grade, variant, quantity, paid, currency)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, me, b.catalogId ?? null, String(b.cardName), b.setName ?? null,
       b.cardNumber ?? null, b.imageUrl ?? null, b.grader ?? null,
       b.grade != null ? String(b.grade) : null, b.variant ?? null,
       Math.max(1, Math.min(999, Number(b.quantity) || 1)),
       b.paid != null ? Number(b.paid) : null, b.currency ?? "AUD"],
    );
    return { entryId: id };
  }

  /** Take a card out of the collection.
   *
   *  The user id is in the WHERE clause, not checked beforehand: one statement
   *  that cannot delete somebody else's row is safer than two that could race.
   *
   *  It reports whether a row actually went. Answering ok to a delete that
   *  matched nothing is indistinguishable from a real one, so a screen holding
   *  a stale entry id would show the card disappear and then find it still
   *  there on the next load. */
  @Delete(":entryId")
  async remove(@Param("entryId") entryId: string, @Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const pool = storePool();
    if (!pool) return { error: "no-store" };
    const r = await pool.query(
      "delete from collection where entry_id = $1 and user_id = $2",
      [entryId, me],
    );
    if (!r.rowCount) {
      return { error: "not-found", message: "That card is no longer in your collection." };
    }
    return { ok: true };
  }
}
