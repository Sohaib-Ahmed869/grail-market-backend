import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { signAll, signDownload } from "../photos/s3.js";
import { cancelDeal, dealById, markHandedOver, markReceived, myDeals } from "./deals.js";

// The part of a sale that happens after "yes".
//
// There was nothing here. An accepted offer changed one word on the offer row
// and the two of them were left to work it out in a message thread, with the
// listing still live and still taking offers. The only way a card got closed
// was the seller alone tapping "sold", which the buyer never saw and was never
// asked about.

@Controller("deals")
export class DealsController {
  @Get()
  async mine(@Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated", deals: [] };
    const rows = await myDeals(me);
    return {
      deals: await Promise.all(rows.map(async (d) => ({
        dealId: d.deal_id,
        listingId: d.listing_id,
        state: d.state,
        amount: Number(d.amount),
        currency: d.currency,
        cardName: d.card_name,
        setName: d.set_name,
        imageUrl: await signDownload(
          d.image_url ?? (Array.isArray(d.photos) ? d.photos[0]?.url : null) ?? "",
        ),
        // Which side this person is on. The screen is genuinely different for
        // each — one of them is waiting and the other has something to do.
        role: d.seller_id === me ? "seller" : "buyer",
        counterparty: d.seller_id === me ? d.buyer_name : d.seller_name,
        agreedAt: d.agreed_at,
        handedOverAt: d.handed_over_at,
        completedAt: d.completed_at,
        cancelledAt: d.cancelled_at,
      }))),
    };
  }

  @Get(":id")
  async one(@Param("id") id: string, @Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const d = await dealById(id, me);
    // Same answer for "no such deal" and "not one of yours": the difference
    // tells a caller whether an id exists, which is not theirs to learn.
    if (!d) return { error: "not-found" };
    const role = d.seller_id === me ? "seller" : "buyer";
    return {
      deal: {
        dealId: d.deal_id,
        listingId: d.listing_id,
        state: d.state,
        amount: Number(d.amount),
        currency: d.currency,
        cardName: d.card_name,
        setName: d.set_name,
        cardNumber: d.card_number,
        grader: d.grader,
        grade: d.grade,
        photos: Array.isArray(d.photos) ? await signAll(d.photos) : [],
        role,
        counterparty: role === "seller" ? d.buyer_name : d.seller_name,
        counterpartyId: role === "seller" ? d.buyer_id : d.seller_id,
        agreedAt: d.agreed_at,
        handedOverAt: d.handed_over_at,
        completedAt: d.completed_at,
        cancelledAt: d.cancelled_at,
        cancelReason: d.cancel_reason,
        cancelledByMe: d.cancelled_by === me,
        // What THIS person can do right now, decided here rather than in the
        // app. Two clients working it out from the state separately is two
        // places for it to be wrong.
        can: {
          handOver: role === "seller" && d.state === "agreed",
          confirm: role === "buyer" && d.state === "handed_over",
          cancel: d.state === "agreed" || d.state === "handed_over",
          rate: d.state === "complete",
        },
      },
    };
  }

  /** The seller has sent it. */
  @Post(":id/handover")
  async handover(@Param("id") id: string, @Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const r = await markHandedOver(id, me);
    return r.ok
      ? { state: r.state, message: "Marked as sent. The buyer confirms from here." }
      : { error: r.why, message: say(r.why) };
  }

  /** The buyer has it. Only this closes the deal, and only this writes a comp. */
  @Post(":id/received")
  async received(@Param("id") id: string, @Req() req: Request) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const r = await markReceived(id, me);
    return r.ok
      ? { state: r.state, message: "Confirmed. Rate the seller when you are ready." }
      : { error: r.why, message: say(r.why) };
  }

  @Post(":id/cancel")
  async cancel(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const r = await cancelDeal(id, me, b?.reason ?? null);
    return r.ok
      ? { state: r.state, message: "Called off. The card is back on the market." }
      : { error: r.why, message: say(r.why) };
  }
}

/** Refusals in words, because "not-sent-yet" is a code and not a sentence. */
function say(why: string): string {
  if (why === "not-sent-yet") {
    return "The seller has not marked this as sent yet.";
  }
  if (why === "not-yours") return "That is the other side's to do.";
  if (why === "already-complete") return "This deal is already closed.";
  if (why === "already-cancelled") return "This deal was already called off.";
  if (why === "not-found") return "That deal could not be found.";
  return "That could not be done.";
}
