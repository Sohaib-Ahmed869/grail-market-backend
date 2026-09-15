import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { storePool } from "../cards.store.js";
import { dealById } from "../listings/deals.js";
import { distanceKm, geocode, midpoint, rankShops, shopsNear, type Point } from "./places.js";

@Controller("meetups")
export class MeetupsController {
  /** Card shops between the two people on a deal.
   *
   *  The seller's side is the suburb on their listing. The buyer's side is
   *  whatever suburb or postcode the buyer types in the handover step — sent
   *  here, used to find a point, and not written anywhere. Either party may
   *  ask; the answer is the same shops for both.
   *
   *  A suggestion, never a requirement: the two may meet at either home, and
   *  the app says so. */
  @Get("shops")
  async shops(@Req() req: Request, @Query("deal") dealId?: string, @Query("near") near?: string) {
    const me = callerId(req);
    if (!me) return { error: "unauthenticated" };
    const deal = dealId ? await dealById(dealId, me) : null;
    if (dealId && !deal) return { error: "not-found" };

    let sellerSuburb: string | null = null;
    if (deal) {
      const pool = storePool();
      const r = pool ? await pool.query("select suburb from listings where listing_id = $1", [deal.listing_id]) : null;
      sellerSuburb = r?.rows[0]?.suburb ?? null;
    }

    const [a, b] = await Promise.all([
      sellerSuburb ? geocode(sellerSuburb) : Promise.resolve(null),
      near ? geocode(near) : Promise.resolve(null),
    ]);
    const points = [a, b].filter((p): p is Point => p != null);
    if (!points.length) {
      return {
        shops: [], centre: null,
        note: sellerSuburb || near
          ? "We couldn't place that suburb on a map. Try a suburb and state, or a postcode."
          : "Add your suburb or postcode to see card shops between you.",
      };
    }
    const centre = points.length === 2 ? midpoint(points[0]!, points[1]!) : points[0]!;
    // Wide enough to reach a shop from both sides, never wider than a drive
    // anyone would make to swap a card.
    const apart = points.length === 2 ? distanceKm(points[0]!, points[1]!) : 0;
    const radius = Math.min(Math.max(apart / 2 + 5, 8), 40);

    const found = await shopsNear(centre, radius);
    if (found == null) {
      // The first lookup for a part of the country fetches its shops in the
      // background; it is usually ready within a minute and saved for a month.
      return { shops: [], centre, note: "Still finding card shops around you. Pull to refresh in a minute.", retry: true };
    }
    const sideA = points[0]!, sideB = points[1] ?? points[0]!;
    const shops = rankShops(found, sideA, sideB).slice(0, 6).map((s) => ({
      ...s,
      // "from the seller" / "from you" depends on who is looking, so the
      // distances are labelled by role and the app picks which is "you".
      fromSellerKm: a ? Math.round(distanceKm(a, s) * 10) / 10 : null,
      fromBuyerKm: b ? Math.round(distanceKm(b, s) * 10) / 10 : null,
      mapsUrl: `https://maps.apple.com/?q=${encodeURIComponent(s.name)}&ll=${s.lat},${s.lon}`,
    }));
    return {
      shops,
      centre,
      sellerSuburb,
      note: shops.length ? null : "No card or game shops found between you. A busy public place works too.",
      attribution: "Shop locations © OpenStreetMap contributors",
    };
  }
}
