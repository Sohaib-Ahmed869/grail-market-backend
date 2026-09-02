import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { readSubscription } from "../billing/store.js";
import { findPlan, PLANS } from "../billing/plans.js";
import { ANGLES, MIN_PHOTOS, photosConfigured, signUpload, type Angle } from "../photos/s3.js";
import {
  browseListings, bumpView, createListing, getListing, listingsBySeller,
  liveCount, moveListing, reviewQueue, setPhotos,
} from "./store.js";
import { makeOffer, offersByBuyer, offersFor, settleOffer } from "./offers.js";
import { recordSale } from "../sales/ledger.js";
import { note } from "../messages/store.js";
import { notify } from "../notifications/store.js";

const need = (req: Request) => callerId(req);

@Controller("listings")
export class ListingsController {
  /** The market. Open to everyone — browsing needs no account, per the
   *  levels screen, and a marketplace nobody can look into has nothing to
   *  join for. */
  @Get()
  async browse(
    @Query("game") game?: string, @Query("grader") grader?: string,
    @Query("graded") graded?: string, @Query("min") min?: string,
    @Query("max") max?: string, @Query("sort") sort?: string,
    @Query("catalogId") catalogId?: string,
    @Req() req?: Request,
  ) {
    const rows = await browseListings({
      game: game ?? null, grader: grader ?? null, catalogId: catalogId ?? null,
      excludeSeller: req ? callerId(req) : null,
      graded: graded === "true" ? true : graded === "false" ? false : null,
      min: min ? Number(min) : null, max: max ? Number(max) : null,
      sort: sort ?? null,
    });
    return { listings: rows.map(publicShape), sort: sort ?? "featured" };
  }

  @Get("mine")
  async mine(@Req() req: Request) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    const [rows, sub] = await Promise.all([listingsBySeller(me), readSubscription(me)]);
    const plan = findPlan(sub?.plan_id ?? "");
    const live = rows.filter((r) => ["live", "in_review"].includes(r.status)).length;
    return {
      listings: rows.map(sellerShape),
      // The ceiling is reported with the listings rather than discovered at
      // the moment of publishing, so hitting it is never a surprise.
      quota: { plan: plan?.name ?? null, limit: plan?.listings ?? null, used: live },
    };
  }

  /** The review queue. The reason a listing exists at all is that a human
   *  looked at it. */
  @Get("queue")
  async queue(@Req() req: Request) {
    if (!need(req)) return { error: "unauthenticated" };
    // TODO(admin): gate on an admin role once one exists.
    return { listings: (await reviewQueue()).map(sellerShape) };
  }

  @Get(":id")
  async one(@Param("id") id: string, @Req() req: Request) {
    const l = await getListing(id);
    if (!l) return { error: "not-found" };
    const me = need(req);
    // A listing in review is visible to its seller and nobody else.
    if (l.status !== "live" && l.seller_id !== me) return { error: "not-found" };
    if (l.status === "live" && me !== l.seller_id) void bumpView(id);
    return { listing: l.seller_id === me ? sellerShape(l) : publicShape(l) };
  }

  /** Step 1-3 of the sell flow, in one call. The draft exists before any
   *  photograph is taken, because the photos need a listing id to belong to. */
  @Post()
  async create(@Req() req: Request, @Body() b: any) {
    const me = need(req);
    if (!me) return { error: "unauthenticated", message: "Sign in first." };

    const sub = await readSubscription(me);
    const plan = findPlan(sub?.plan_id ?? "");
    if (!plan) {
      return { error: "no-plan", message: "Choose a plan before listing.", plans: PLANS.map((p) => p.id) };
    }
    if (plan.listings != null && (await liveCount(me)) >= plan.listings) {
      return {
        error: "quota", message:
          `${plan.name} allows ${plan.listings} live listing${plan.listings === 1 ? "" : "s"}. Upgrade to list more.`,
      };
    }
    if (!b?.cardName || !(Number(b?.price) > 0)) {
      return { error: "invalid", message: "A card and a price are required." };
    }

    const id = await createListing({
      sellerId: me, catalogId: b.catalogId ?? null, cardName: String(b.cardName),
      setName: b.setName ?? null, cardNumber: b.cardNumber ?? null, game: b.game ?? null,
      imageUrl: b.imageUrl ?? null, grader: b.grader ?? null,
      grade: b.grade != null ? String(b.grade) : null, certNumber: b.certNumber ?? null,
      variant: b.variant ?? null,
      isRaw: Boolean(b.isRaw), conditionNote: b.conditionNote ?? null,
      price: Number(b.price), currency: b.currency ?? "AUD",
      marketValue: b.marketValue != null ? Number(b.marketValue) : null,
      strategy: b.strategy ?? null, delivery: b.delivery ?? [], suburb: b.suburb ?? null,
    });
    return id ? { listingId: id, angles: ANGLES } : { error: "no-store" };
  }

  /** URLs the phone uploads its photographs to directly. */
  @Post(":id/photo-urls")
  async photoUrls(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    if (!photosConfigured()) return { error: "photos-unconfigured", message: "Photo storage is not configured." };
    const l = await getListing(id);
    if (!l || l.seller_id !== me) return { error: "not-found" };

    const wanted: string[] = Array.isArray(b?.angles) && b.angles.length ? b.angles : [...ANGLES];
    const urls = await Promise.all(
      wanted.map(async (a) => ({
        angle: a,
        ...(await signUpload(id, a as Angle, b?.contentType ?? "image/jpeg")),
      })),
    );
    return { uploads: urls };
  }

  @Post(":id/photos")
  async photos(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    const ok = await setPhotos(id, me, b?.photos ?? [], b?.videoUrl ?? null);
    if (!ok) return { error: "not-found" };
    const l = await getListing(id);
    return { photoVerified: l?.photo_verified ?? false, count: (b?.photos ?? []).length };
  }

  /** Step 5. The declaration is what makes the identity on file matter. */
  @Post(":id/submit")
  async submit(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    if (!b?.declared) {
      return { error: "not-declared", message: "All four statements must be agreed." };
    }

    // The photograph floor is enforced here as well as in the app. A rule that
    // only the client applies is not a rule — it is a suggestion that anything
    // holding a session token can ignore.
    const l = await getListing(id);
    if (!l || l.seller_id !== me) return { error: "not-found" };
    const shots = Array.isArray(l.photos) ? l.photos.length : 0;
    if (shots < MIN_PHOTOS) {
      return {
        error: "too-few-photos",
        message: `${MIN_PHOTOS} photographs are needed before a listing can go up. This one has ${shots}.`,
      };
    }

    const r = await moveListing(id, "in_review", { sellerId: me });
    return r.ok ? { status: "in_review" } : { error: r.why };
  }

  /** Admin. Nothing reaches a buyer without passing through here. */
  @Post(":id/review")
  async review(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    if (!need(req)) return { error: "unauthenticated" };
    // TODO(admin): gate on an admin role once one exists.
    const to = b?.approve ? "live" : "rejected";
    const r = await moveListing(id, to, { reason: b?.reason ?? null });
    if (r.ok) {
      const l = await getListing(id);
      if (l) {
        await notify({
          userId: l.seller_id, kind: "listing",
          title: b?.approve
            ? `${l.card_name} is live on the market`
            : `${l.card_name} needs changes before it can go up`,
          body: b?.approve ? null : (b?.reason ?? null),
          href: b?.approve ? `/listing/${id}` : "/mylistings",
        });
      }
    }
    return r.ok ? { status: to } : { error: r.why };
  }

  @Post(":id/withdraw")
  async withdraw(@Param("id") id: string, @Req() req: Request) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    const r = await moveListing(id, "withdrawn", { sellerId: me });
    return r.ok ? { status: "withdrawn" } : { error: r.why };
  }

  /** Marked by the seller once the card has changed hands.
   *
   *  This is also where a sale becomes a comp. Our own completed trades are
   *  the one source of confirmed sales we control, and they carry a real date
   *  and a link that resolves — which is why the ledger was built. */
  @Post(":id/sold")
  async sold(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    const l = await getListing(id);
    if (!l || l.seller_id !== me) return { error: "not-found" };
    const r = await moveListing(id, "sold", { sellerId: me });
    if (!r.ok) return { error: r.why };

    if (l.catalog_id) {
      await recordSale({
        catalogId: l.catalog_id, grader: l.grader, grade: l.grade,
        price: Number(b?.price ?? l.price), currency: l.currency,
        soldAt: new Date(), source: "grailmarket",
        sourceUrl: `grailmarket://listing/${id}`,
        rawTitle: `${l.card_name}${l.set_name ? ` · ${l.set_name}` : ""}`,
      }).catch(() => null);
    }
    return { status: "sold" };
  }

  // ---- offers ---------------------------------------------------------------

  @Get(":id/offers")
  async listOffers(@Param("id") id: string, @Req() req: Request) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    const l = await getListing(id);
    if (!l || l.seller_id !== me) return { error: "not-found" };
    // The card the offers are on, not just the numbers. A grade is half of
    // what an offer means: 900 is generous for a PSA 8 and an insult for a 10.
    return {
      offers: await offersFor(id),
      marketValue: l.market_value, asking: l.price,
      cardName: l.card_name, setName: l.set_name,
      grader: l.grader, grade: l.grade, imageUrl: l.image_url,
    };
  }

  @Post(":id/offers")
  async offer(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const me = need(req);
    if (!me) return { error: "unauthenticated", message: "Sign in to make an offer." };
    const l = await getListing(id);
    if (!l || l.status !== "live") return { error: "not-found" };
    if (l.seller_id === me) return { error: "own-listing", message: "That's your own listing." };
    const amount = Number(b?.amount);
    if (!(amount > 0)) return { error: "invalid", message: "Enter an amount." };

    const offerId = await makeOffer({
      listingId: id, buyerId: me, sellerId: l.seller_id,
      amount, currency: l.currency, note: b?.note ?? null,
    });
    // The offer opens the conversation. Two people negotiating in a thread
    // that does not mention the offer they are negotiating is how a deal ends
    // up agreed in two places with different numbers.
    const money = `${l.currency === "AUD" ? "A$" : "$"}${Math.round(amount).toLocaleString()}`;
    await note(id, me, `Offer of ${money} made.`).catch(() => null);
    await notify({
      userId: l.seller_id, kind: "offer", actorId: me,
      title: `${money} offered on ${l.card_name}`,
      body: b?.note ? String(b.note).slice(0, 140) : null,
      href: `/offers/${id}`,
    });
    return { offerId, amount };
  }

  @Post("offers/:offerId/settle")
  async settle(@Param("offerId") offerId: string, @Req() req: Request, @Body() b: any) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    const action = String(b?.action) as "accepted" | "declined" | "countered";
    if (!["accepted", "declined", "countered"].includes(action)) return { error: "invalid" };
    const r = await settleOffer(offerId, me, action, b?.amount != null ? Number(b.amount) : undefined);
    return r.ok ? { status: r.status } : { error: r.why };
  }

  @Get("offers/mine")
  async myOffers(@Req() req: Request) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    return { offers: await offersByBuyer(me) };
  }
}

/** What a buyer sees. Deliberately omits the seller's own analytics — views
 *  and saves are for the person who listed it, never for the person deciding
 *  whether it has gone stale. */
function publicShape(l: any) {
  // seller_id stays: it is an opaque handle, and without it a buyer cannot
  // open the page of the person they are about to send money to. Views and
  // saves are still the seller's own business — same number, opposite use.
  const { views, saves, reject_reason, ...rest } = l;
  return { ...rest, featured: l.featured_until != null && new Date(l.featured_until) > new Date() };
}
const sellerShape = (l: any) => ({
  ...l, featured: l.featured_until != null && new Date(l.featured_until) > new Date(),
});
