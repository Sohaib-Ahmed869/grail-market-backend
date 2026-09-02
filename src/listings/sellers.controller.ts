import { Controller, Get, Param } from "@nestjs/common";
import { storePool } from "../cards.store.js";

// Who you are dealing with.
//
// A listing that says "Verified seller" and nothing else is asking for trust
// without offering anything to check. This is the page behind that badge: a
// name, how long they have been here, what the ID check actually says, and
// every other card they have up.
//
// What is NOT here is as deliberate as what is. No email, no phone, no
// address — a verified member is identifiable, not exposed. The suburb comes
// from the listings themselves because that is already public on each card,
// and a buyer arranging a pickup needs to know the city before they offer.

@Controller("sellers")
export class SellersController {
  @Get(":sellerId")
  async profile(@Param("sellerId") sellerId: string) {
    const pool = storePool();
    if (!pool) return { error: "no-store" };

    const u = await pool.query(
      `select u.user_id, u.name, u.created_at,
              coalesce(i.status, 'Not Started') as identity,
              i.verified_at
         from users u
         left join identity_status i on i.user_id = u.user_id
        where u.user_id = $1`,
      [sellerId],
    );
    const row = u.rows[0];
    if (!row) return { error: "not-found" };

    const [counts, listings] = await Promise.all([
      pool.query(
        `select
           count(*) filter (where status = 'live')::int  as live,
           count(*) filter (where status = 'sold')::int  as sold,
           min(live_at)                                  as first_listed
         from listings where seller_id = $1`,
        [sellerId],
      ),
      pool.query(
        `select * from listings
          where seller_id = $1 and status = 'live'
          order by (featured_until > now()) desc nulls last, live_at desc
          limit 24`,
        [sellerId],
      ),
    ]);

    const c = counts.rows[0] ?? { live: 0, sold: 0, first_listed: null };
    // Where they trade, taken from their own live listings. Deduped, because
    // three cards in Fitzroy is one place, not three.
    const suburbs = [...new Set(listings.rows.map((l: any) => l.suburb).filter(Boolean))];

    return {
      sellerId: row.user_id,
      name: row.name,
      memberSince: row.created_at,
      verified: row.identity === "Approved",
      verifiedAt: row.verified_at,
      live: c.live,
      sold: c.sold,
      firstListed: c.first_listed,
      suburbs,
      listings: listings.rows.map((l: any) => {
        const { views, saves, reject_reason, ...rest } = l;
        return { ...rest, featured: l.featured_until != null && new Date(l.featured_until) > new Date() };
      }),
    };
  }
}
