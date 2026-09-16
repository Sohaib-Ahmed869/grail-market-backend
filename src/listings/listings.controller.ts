import {
  Body, Controller, Get, Param, Post, Query, Req, UploadedFile, UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { callerId } from "../auth/auth.controller.js";
import { denied, requireCapability } from "../admin/guard.js";
import { activePlanId, readSubscription } from "../billing/store.js";
import { PLANS } from "../billing/plans.js";
import { canCreateListing, entitlementFor } from "../billing/entitlement.js";
import { ANGLES, photosConfigured, signAll, signDownload, signUpload, type Angle, putPhoto } from "../photos/s3.js";
import {
  browseListings, bumpView, createListing, editListing, getListing, listingsBySeller,
  liveCount, moveListing, reviewQueue, setPhotos,
} from "./store.js";
import {
  makeOffer, offersByBuyer, offersFor, settleOffer, offersToSeller, hasStakeIn,
  replyToCounter,
} from "./offers.js";
import { recordSale } from "../sales/ledger.js";
import { note } from "../messages/store.js";
import { notify } from "../notifications/store.js";
import { censor } from "../community/censor.js";
import { readSettings } from "../admin/settings.store.js";
import { readStatus as readIdentity } from "../identity/store.js";
import { autoPublish } from "./autopublish.js";
import { publicListing } from "./publicshape.js";
import { fillListingPoints, locateListing, parseNear, parseWithin, suburbProblem } from "./nearby.js";
import { storePool } from "../cards.store.js";

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
    @Query("set") setName?: string,
    @Query("number") cardNumber?: string,
    @Query("variant") variant?: string,
    @Query("grade") grade?: string,
    @Query("q") q?: string,
    @Query("language") language?: string,
    @Query("offset") offset?: string,
    @Query("limit") limit?: string,
    // The viewer's own point, for "how far away". Rounded on the way in and
    // never stored — see listings/nearby.ts.
    @Query("lat") lat?: string,
    @Query("lon") lon?: string,
    @Query("within") within?: string,
    @Req() req?: Request,
  ) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const off = Math.max(Number(offset) || 0, 0);
    const lang = language === "en" || language === "ja" || language === "other" ? language : null;
    const near = parseNear(lat, lon);
    // Listings not yet placed on the map get placed a few at a time by the
    // requests that want distances, without holding this one up.
    if (near) void fillListingPoints();
    // One row more than the page, so whether another page exists is known
    // without a count query.
    const fetched = await browseListings({
      game: game ?? null, grader: grader ?? null, catalogId: catalogId ?? null,
      setName: setName ?? null, cardNumber: cardNumber ?? null,
      variant: variant ?? null, grade: grade ?? null, q: q ?? null,
      excludeSeller: req ? callerId(req) : null,
      graded: graded === "true" ? true : graded === "false" ? false : null,
      min: min ? Number(min) : null, max: max ? Number(max) : null,
      sort: sort ?? null,
      language: lang, offset: off, limit: lim + 1,
      near, withinKm: near ? parseWithin(within) : null,
    });
    const more = fetched.length > lim;
    const rows = more ? fetched.slice(0, lim) : fetched;
    return {
      listings: await signPreviews(rows.map(publicShape)),
      sort: sort ?? "featured",
      next: more ? off + lim : null,
    };
  }

  @Get("mine")
  async mine(@Req() req: Request) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    // Same entitlement question as create(), so the ceiling shown on the
    // screen is the ceiling that will actually be enforced. Reading plan_id
    // here and the paying plan there is how "1 of 10 live" sits above a
    // refusal to publish.
    const [rows, planId, identity] = await Promise.all([
      listingsBySeller(me), activePlanId(me), readIdentity(me),
    ]);
    const { plan } = entitlementFor({ paidPlanId: planId, identityApproved: identity?.status === "Approved" });
    const live = rows.filter((r) => ["live", "in_review"].includes(r.status)).length;
    return {
      listings: await signPreviews(rows.map(sellerShape)),
      // The ceiling is reported with the listings rather than discovered at
      // the moment of publishing, so hitting it is never a surprise.
      quota: { plan: plan?.name ?? null, limit: plan?.listings ?? null, used: live, free: Boolean(plan?.free) },
    };
  }

  /** The review queue. The reason a listing exists at all is that a human
   *  looked at it. */
  @Get("queue")
  async queue(@Req() req: Request) {
    // Staff only, for the same reason as `review` below — and this one leaks
    // as well as grants: the queue returns `sellerShape`, which carries other
    // people's unpublished drafts, their certificate numbers and their
    // photographs, to anyone holding any session token.
    const who = await requireCapability(req, "listings.review");
    if (denied(who)) return { error: who.error, message: who.message };
    return { listings: await signPreviews((await reviewQueue()).map(sellerShape)) };
  }

  @Get(":id")
  async one(@Param("id") id: string, @Req() req: Request) {
    const l = await getListing(id);
    if (!l) return { error: "not-found" };
    const me = need(req);
    // A listing in review is visible to its seller and nobody else — but a
    // listing that has STOPPED being live because somebody bought it has to
    // stay visible to the person who bought it.
    //
    // Accepting an offer moves a listing to `reserved`, and this test then hid
    // it from the buyer: their own offers list, the message thread and the
    // notification all linked to a page that answered "Listing Not Available".
    // It also meant the dispute entry point, which only renders on a sold
    // listing, was reachable by the seller and never by the buyer — who is the
    // one who would raise a dispute.
    const partyToIt = Boolean(me) && (l.seller_id === me || (await hasStakeIn(id, me!)));
    if (l.status !== "live" && !partyToIt) return { error: "not-found" };
    if (l.status === "live" && me !== l.seller_id) void bumpView(id);
    const shaped = l.seller_id === me ? sellerShape(l) : publicShape(l);
    // The bucket is not public, so the stored object URLs 403 for everyone.
    // Signed only on the single-listing read: the market grid shows one
    // thumbnail per card and signing every photo of every listing to render a
    // grid is a signature nobody looks at.
    if (Array.isArray((shaped as any).photos)) {
      (shaped as any).photos = await signAll((shaped as any).photos);
    }
    return { listing: shaped };
  }

  /** Step 1-3 of the sell flow, in one call. The draft exists before any
   *  photograph is taken, because the photos need a listing id to belong to. */
  @Post()
  async create(@Req() req: Request, @Body() b: any) {
    const me = need(req);
    if (!me) return { error: "unauthenticated", message: "Sign in first." };

    // The plan they are actually PAYING for. This read plan_id straight off
    // the row with no status check, so a cancelled or past_due subscription —
    // which keeps its plan_id, because Stripe does not blank it — still bought
    // the right to list. The scan path already guarded this; both now ask the
    // same function so one subscription cannot mean two different things.
    //
    // With no paid plan, a seller whose identity check passed still gets one
    // free active listing (GM001-32). The rule lives in billing/entitlement.ts
    // so this and /mine cannot disagree about it.
    const [paidPlanId, identity] = await Promise.all([activePlanId(me), readIdentity(me)]);
    const entitlement = entitlementFor({ paidPlanId, identityApproved: identity?.status === "Approved" });
    const allowed = canCreateListing(entitlement, entitlement.plan?.listings != null ? await liveCount(me) : 0);
    if (!allowed.ok) {
      return allowed.error === "no-plan"
        ? { error: "no-plan", message: allowed.message, plans: PLANS.map((p) => p.id) }
        : { error: "quota", message: allowed.message };
    }
    if (!b?.cardName || !(Number(b?.price) > 0)) {
      return { error: "invalid", message: "A card and a price are required." };
    }
    // And a suburb, now. The card shop finder (GM001-65) takes the seller's
    // side of the meet-up FROM the listing suburb, so a listing without one
    // silently breaks the main physical safety control the no-escrow model
    // rests on — and a buyer browsing has no distance to judge it by either.
    const suburbFault = suburbProblem(b?.suburb);
    if (suburbFault) return { error: "invalid", message: suburbFault };

    const id = await createListing({
      sellerId: me, catalogId: b.catalogId ?? null, cardName: String(b.cardName),
      setName: b.setName ?? null, cardNumber: b.cardNumber ?? null, game: b.game ?? null,
      imageUrl: b.imageUrl ?? null, grader: b.grader ?? null,
      grade: b.grade != null ? String(b.grade) : null, certNumber: b.certNumber ?? null,
      variant: b.variant ?? null,
      isRaw: Boolean(b.isRaw),
      // A seller can put a number in the condition note just as easily as in
      // a message. Public text is public text.
      conditionNote: b.conditionNote ? censor(String(b.conditionNote)).text : null,
      price: Number(b.price), currency: b.currency ?? "AUD",
      marketValue: b.marketValue != null ? Number(b.marketValue) : null,
      strategy: b.strategy ?? null, delivery: b.delivery ?? [], suburb: b.suburb ?? null,
    });
    // Place the suburb now rather than on the first browse that wants it.
    if (id && b.suburb) void locateListing(id);
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

  /** One photograph, posted straight to us as multipart.
   *
   *  The presigned PUT beside this still exists and the browser still uses it.
   *  React Native cannot: the only way to build a body for a raw PUT there is
   *  `fetch(fileUri).blob()`, and RN's Blob is partial enough that the request
   *  goes up empty or throws — which is why ten photographs failed silently
   *  and a listing sat in `draft`, never reaching the review queue.
   *
   *  Multipart is the shape the scan upload has always used from the phone, so
   *  this is the path we already know works rather than a second guess. */
  @Post(":id/photo")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }))
  async photo(
    @Param("id") id: string,
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() b: any,
  ) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    if (!photosConfigured()) {
      return { error: "photos-unconfigured", message: "Photo storage is not configured." };
    }
    if (!file?.buffer?.length) {
      return { error: "no-file", message: "No photograph was received." };
    }
    const l = await getListing(id);
    if (!l || l.seller_id !== me) return { error: "not-found" };

    const angle = String(b?.angle ?? "front");
    try {
      const up = await putPhoto(id, angle, file.buffer, file.mimetype || "image/jpeg");
      return { angle, url: up.publicUrl };
    } catch (e: any) {
      console.error("[listings] photo upload failed:", e?.message);
      return { error: "upload-failed", message: "That photograph could not be stored." };
    }
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

    const l = await getListing(id);
    if (!l || l.seller_id !== me) return { error: "not-found" };

    // Every requirement on this step comes from the Review thresholds page —
    // the API enforces it here as well as in the app, because a rule that
    // only the client applies is not a rule, it is a suggestion that anything
    // holding a session token can ignore.
    const settings = await readSettings();

    const shots = Array.isArray(l.photos) ? l.photos.length : 0;
    if (shots < settings.minPhotos) {
      return {
        error: "too-few-photos",
        message: `${settings.minPhotos} photographs are needed before a listing can go up. This one has ${shots}.`,
      };
    }

    // "Require a certificate number for slabbed cards." A grade always
    // belongs to a grading company, so a listing with a grader on it but no
    // certificate is exactly the case this setting names.
    if (settings.requireCert && l.grader && !l.is_raw && !l.cert_number) {
      return {
        error: "cert-required",
        message: `A certificate number is required for a ${l.grader}-graded card.`,
      };
    }

    // "Allow raw (ungraded) cards above the high-value floor." Off by
    // default — an expensive raw card is the hardest thing on the platform
    // to authenticate from photographs.
    if (!settings.allowRaw && l.is_raw && Number(l.price) >= settings.highValueFloor) {
      return {
        error: "raw-above-floor",
        message:
          `Raw cards above A$${settings.highValueFloor.toLocaleString()} are not accepted. ` +
          "Get this one graded, or lower the asking price.",
      };
    }

    const identity = await readIdentity(me);
    const identityApproved = identity?.status === "Approved";

    // Tier 3: selling at or above the high-value floor needs a passed identity
    // check. The tier ladder has always said so and nothing enforced it at
    // the one moment it matters, which is here.
    if (Number(l.price) >= settings.highValueFloor && !identityApproved) {
      return {
        error: "identity-required",
        message:
          `Listings at A$${settings.highValueFloor.toLocaleString()} or more need a verified identity. ` +
          "Verify once, then submit again.",
      };
    }

    const r = await moveListing(id, "in_review", { sellerId: me });
    if (!r.ok) return { error: r.why };

    // Every listing is checked; the ones that pass every check under the
    // auto-publish value go straight up. The rest wait for a person, with the
    // reasons attached — see autopublish.ts for exactly what is tested.
    const pool = storePool();
    const standing = pool
      ? (await pool.query("select standing from users where user_id = $1", [me])).rows[0]?.standing ?? null
      : null;
    const decision = autoPublish({
      price: Number(l.price),
      marketValue: l.market_value != null ? Number(l.market_value) : null,
      catalogId: l.catalog_id ?? null,
      photoVerified: Boolean(l.photo_verified),
      graded: Boolean(l.grader) && !l.is_raw,
      certNumber: l.cert_number ?? null,
      sellerStanding: standing,
      identityApproved,
    }, { enabled: settings.autoClear, below: settings.autoPublishBelow });

    if (decision.publish) {
      const live = await moveListing(id, "live", { reason: "Passed every automatic check" });
      if (live.ok) {
        await notify({
          userId: me, kind: "listing",
          title: `${l.card_name} is live on the market`, body: null, href: `/listing/${id}`,
        });
        return { status: "live", automatic: true };
      }
    }
    return { status: "in_review", held: settings.autoClear ? decision.held : [] };
  }

  /** Admin. Nothing reaches a buyer without passing through here.
   *
   *  That sentence was not true until now. The gate was a TODO waiting on an
   *  admin role, and the role arrived without anyone coming back — so the
   *  check was `need(req)`, which any signed-in account passes. A seller could
   *  submit their own listing and then approve it, straight past the review
   *  this endpoint exists to be, with nothing but their own session token.
   *
   *  `listings.review` was already defined in `admin/roles.ts` and already
   *  granted to the roles that should have it; it only had to be asked for. */
  @Post(":id/review")
  async review(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "listings.review");
    if (denied(who)) return { error: who.error, message: who.message };
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

  /** Edit a listing that is already up. */
  @Post(":id/edit")
  async edit(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };

    // Checked only when the seller is actually changing it. `undefined` here
    // means "leave it alone", and a listing that went up before a suburb was
    // required must not have a price edit refused over a field it never had.
    if (b?.suburb != null) {
      const fault = suburbProblem(b.suburb);
      if (fault) return { error: "invalid", message: fault };
    }

    const before = await getListing(id);
    const r = await editListing(id, me, {
      price: b?.price != null ? Number(b.price) : undefined,
      conditionNote: b?.conditionNote ?? undefined,
      delivery: Array.isArray(b?.delivery) ? b.delivery : undefined,
      suburb: b?.suburb ?? undefined,
    });
    if (!r.ok) return { error: r.why };
    // A moved suburb must not keep the old one's distance.
    if (b?.suburb != null && b.suburb !== before?.suburb) void locateListing(id);

    // Anyone with an open offer has a stake in the price changing — they are
    // negotiating against a number that just moved, and finding out by
    // accident is how a buyer feels tricked by an honest discount.
    if (r.priceChanged && before) {
      const pool = (await import("../cards.store.js")).storePool();
      const rows = pool
        ? (await pool.query(
            "select distinct buyer_id from offers where listing_id = $1 and status = 'open'",
            [id],
          )).rows
        : [];
      const money = (n: number) =>
        `${before.currency === "AUD" ? "A$" : "$"}${Math.round(n).toLocaleString()}`;
      const down = Number(b.price) < Number(before.price);
      for (const row of rows) {
        await notify({
          userId: row.buyer_id, kind: "listing", actorId: me,
          title: `${before.card_name} is now ${money(Number(b.price))}`,
          body: `${down ? "Down" : "Up"} from ${money(Number(before.price))}. Your offer still stands.`,
          href: `/listing/${id}`,
        });
      }
    }
    return { ok: true, priceChanged: r.priceChanged };
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
    if (!l) return { error: "not-found" };
    // A card already promised to somebody is not missing, and saying so is not
    // a leak — it is on the market page in front of them. "Not found" for a
    // listing they are looking at reads as the app being broken.
    if (l.status === "reserved") {
      return {
        error: "reserved",
        message: "This one is under offer already. It comes back if the deal falls through.",
      };
    }
    if (l.status !== "live") {
      return { error: "not-available", message: "This listing is not taking offers." };
    }
    if (l.seller_id === me) return { error: "own-listing", message: "That's your own listing." };
    const amount = Number(b?.amount);
    if (!(amount > 0)) return { error: "invalid", message: "Enter an amount." };

    // The note travels to the seller and into a notification body, so it is
    // the same exposure as a message and gets the same treatment. It did not
    // have it, and a phone number went straight through.
    const noteText = b?.note ? censor(String(b.note)).text : null;

    const offerId = await makeOffer({
      listingId: id, buyerId: me, sellerId: l.seller_id,
      amount, currency: l.currency, note: noteText,
    });
    // The offer opens the conversation. Two people negotiating in a thread
    // that does not mention the offer they are negotiating is how a deal ends
    // up agreed in two places with different numbers.
    const money = `${l.currency === "AUD" ? "A$" : "$"}${Math.round(amount).toLocaleString()}`;
    await note(id, me, `Offer of ${money} made.`).catch(() => null);
    await notify({
      userId: l.seller_id, kind: "offer", actorId: me,
      title: `${money} offered on ${l.card_name}`,
      body: noteText ? noteText.slice(0, 140) : null,
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
    // The deal id travels back so the app can go straight to it. Accepting an
    // offer and then having to hunt for what happens next is the gap this
    // whole flow exists to close.
    return r.ok ? { status: r.status, dealId: r.dealId ?? null } : { error: r.why };
  }

  /** The buyer answering a counter: take it, walk away, or come back with a
   *  number of their own.
   *
   *  Without this the negotiation had one move in it. The seller countered and
   *  the buyer was left looking at a figure with no way to act on it — the
   *  offer sat "countered" forever and the deal died of having no next step. */
  @Post("offers/:offerId/reply")
  async replyOffer(@Param("offerId") offerId: string, @Req() req: Request, @Body() b: any) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    const action = String(b?.action) as "accepted" | "declined" | "countered";
    if (!["accepted", "declined", "countered"].includes(action)) return { error: "invalid" };
    const amount = b?.amount != null ? Number(b.amount) : undefined;
    if (action === "countered" && !(Number(amount) > 0)) {
      return { error: "invalid", message: "Enter an amount." };
    }
    const r = await replyToCounter(offerId, me, action, amount);
    return r.ok
      ? { status: r.status, dealId: r.dealId ?? null, offerId: r.offerId ?? null }
      : { error: r.why };
  }

  @Get("offers/mine")
  async myOffers(@Req() req: Request) {
    const me = need(req);
    if (!me) return { error: "unauthenticated" };
    // Both directions. A person is a buyer on some listings and a seller on
    // others, and one screen that only ever showed one of those told half of
    // them they had no offers.
    const [made, received] = await Promise.all([offersByBuyer(me), offersToSeller(me)]);
    return { offers: made, received };
  }
}

/** What a buyer sees. Deliberately omits the seller's own analytics — views
 *  and saves are for the person who listed it, never for the person deciding
 *  whether it has gone stale. */
/** Sign the FIRST photo of each listing, and only the first.
 *
 *  A market card draws one thumbnail — `photos[0].url` — and the bucket is not
 *  public, so every one of them 403'd and the grid rendered as empty frames.
 *  The single-listing read signs all ten angles because somebody is about to
 *  look at all ten; a grid of forty cards needs forty signatures, not four
 *  hundred, so the rest are left alone and signed when the card is opened. */
async function signPreviews<T extends { photos?: unknown }>(rows: T[]): Promise<T[]> {
  return Promise.all(
    rows.map(async (r) => {
      const photos = (r as any).photos;
      if (!Array.isArray(photos) || photos.length === 0 || !photos[0]?.url) return r;
      const [first, ...rest] = photos;
      return { ...r, photos: [{ ...first, url: await signDownload(first.url) }, ...rest] };
    }),
  );
}

// seller_id stays public: it is an opaque handle, and without it a buyer
// cannot open the page of the person they are about to pay. Everything else
// that is not on the allowlist in publicshape.ts — views, saves, moderation
// notes, who reviewed it — stays with the seller and the console.
const publicShape = (l: any) => publicListing(l);
const sellerShape = (l: any) => ({
  ...l, featured: l.featured_until != null && new Date(l.featured_until) > new Date(),
});
