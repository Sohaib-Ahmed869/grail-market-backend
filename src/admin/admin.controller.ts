import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { getListing, moveListing } from "../listings/store.js";
import { notify } from "../notifications/store.js";
import { denied, devAuthActive, requireCapability, requireStaff } from "./guard.js";
import { capabilitiesOf, isRole, ROLE_LABEL } from "./roles.js";
import {
  addCaseNote, adminCase, adminCases, caseCounts, caseThread, claimCase,
  decideCase, isOutcome, isState, setCaseState,
} from "./conduct.store.js";
import {
  adminMember, adminMembers, adminStaff, annotateMember, memberTimeline,
  setStanding, type MemberStatus,
} from "./members.store.js";
import { setRole } from "./store.js";
import {
  adminTicket, adminTickets, isPriority, isStatus, isTier, openTicket,
  replyToTicket, REPLY_TARGET, setTicket, ticketContext, ticketCounts,
  ticketThread, TIERS,
} from "./support.store.js";
import {
  adminListing, adminListings, annotate, claimListing, listingComps,
  listingPhotos, queueCounts, releaseListing, sellerHistory, SLA_HOURS, VIEWS,
} from "./listings.store.js";
import {
  adminBoost, adminPlans, applyBoost, billingLedger, boostLedger, BOOST_TIERS,
  compBoost, compPlan, planExists,
} from "./commerce.store.js";
import {
  compsFor, excludedComps, feedHealth, gradeSets, medianOf, ruleOnComp,
} from "./pricing.store.js";

// The admin console's own API.
//
// It is separate from `/listings` on purpose. The seller endpoints answer "what
// can I do with my card"; these answer "what is waiting on us and what did we
// decide", which is a different question with a different audience and a
// different way in. Sharing one controller between the two is how a member
// ends up one query parameter away from the queue.

@Controller("admin")
export class AdminController {
  /**
   * Who is signed in, and what that opens.
   *
   * The console calls this before it draws anything. It is the only place the
   * role comes from — the client has a copy of the capability table so it can
   * hide controls, but the copy is an interface and this is the answer.
   */
  @Get("me")
  async me(@Req() req: Request) {
    const who = await requireStaff(req);
    if (denied(who)) return who;
    return {
      userId: who.userId,
      name: who.name,
      email: who.email,
      role: who.role,
      roleLabel: ROLE_LABEL[who.role],
      capabilities: capabilitiesOf(who.role),
      slaHours: SLA_HOURS,
      // Said out loud rather than left to be discovered: this session is only
      // signed in because the development shortcut is on.
      devAuth: devAuthActive(req) || undefined,
    };
  }

  /** The queue, and every other view of it. One shape for the table and the
   *  gallery — they are the same rows drawn twice, not two endpoints. */
  @Get("listings")
  async listings(
    @Req() req: Request,
    @Query("view") view?: string,
    @Query("q") q?: string,
    @Query("tier") tier?: string,
  ) {
    const who = await requireCapability(req, "listings.review");
    if (denied(who)) return who;
    // The counts are of the whole queue, not of what the search left — a tab
    // that renumbers itself as you type cannot be used to navigate.
    const [listings, counts] = await Promise.all([
      adminListings({
        view: view && VIEWS[view] ? view : "all",
        search: q?.trim() || null,
        tier: tier ?? null,
      }),
      queueCounts(),
    ]);
    return { listings, counts, slaHours: SLA_HOURS };
  }

  /** One listing, with the three things a decision is taken against: the
   *  sales behind the price, the angles supplied, and the seller. */
  @Get("listings/:id")
  async one(@Param("id") id: string, @Req() req: Request) {
    const who = await requireCapability(req, "listings.review");
    if (denied(who)) return who;
    // All four at once. The store is a few hundred milliseconds away, so four
    // sequential reads is most of a second of a moderator's time per record.
    const [listing, comps, photos, history] = await Promise.all([
      adminListing(id),
      listingComps(id),
      listingPhotos(id),
      sellerHistory(id),
    ]);
    if (!listing) return { error: "not-found" };
    return { listing, comps, photos, history };
  }

  /** Take the row. Two moderators deciding the same card is the thing this
   *  stops; a claim that fails means somebody else already has it. */
  @Post("listings/:id/claim")
  async claim(@Param("id") id: string, @Req() req: Request) {
    const who = await requireCapability(req, "listings.review");
    if (denied(who)) return who;
    const ok = await claimListing(id, who.name);
    if (!ok) {
      const cur = await adminListing(id);
      return {
        error: "already-claimed",
        message: cur?.claimedBy
          ? `${cur.claimedBy} is already working this listing.`
          : "That listing is not waiting on a decision.",
      };
    }
    return { listing: await adminListing(id) };
  }

  @Post("listings/:id/release")
  async release(@Param("id") id: string, @Req() req: Request) {
    const who = await requireCapability(req, "listings.review");
    if (denied(who)) return who;
    await releaseListing(id);
    return { listing: await adminListing(id) };
  }

  /**
   * The decision. Three of them, and every one writes to the seller.
   *
   * A rejection with no reason is the failure the feature set names directly:
   * the reason is returned to the seller word for word and filed on their
   * record, so it cannot be optional here.
   */
  @Post("listings/:id/decision")
  async decide(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "listings.review");
    if (denied(who)) return who;

    const decision = String(b?.decision ?? "");
    const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
    const to =
      decision === "approve" ? "live"
      : decision === "reject" ? "rejected"
      : decision === "request" ? "info_requested"
      : null;
    if (!to) return { error: "invalid", message: "Decision must be approve, reject or request." };
    if (to !== "live" && reason.length < 4) {
      return {
        error: "no-reason",
        message:
          to === "rejected"
            ? "A rejection needs a reason. The seller is shown it word for word."
            : "Say what the seller needs to supply.",
      };
    }

    const before = await getListing(id);
    if (!before) return { error: "not-found" };

    const by = who.name;
    const r = await moveListing(id, to, { reason: reason || null, reviewedBy: by });
    if (!r.ok) return { error: r.why };

    // The moderator's note stays on the listing whatever the decision was —
    // an approval with a caveat is worth as much on the next review as a
    // rejection is.
    if (typeof b?.note === "string" && b.note.trim()) {
      await annotate(id, { note: b.note.trim().slice(0, 2000) });
    }

    await notify({
      userId: before.seller_id,
      kind: "listing",
      title:
        to === "live" ? `${before.card_name} is live on the market`
        : to === "rejected" ? `${before.card_name} was not approved`
        : `${before.card_name} needs more before it can go up`,
      body: to === "live" ? null : reason,
      href: to === "live" ? `/listing/${id}` : "/mylistings",
    }).catch(() => null);

    return { listing: await adminListing(id), decidedBy: by };
  }

  /**
   * What happens to a listing that is already on the market.
   *
   * Pause is not withdraw. Withdrawing is final and kills the listing; pausing
   * takes it off the market and gives it back. Offering only the final one is
   * why every temporary hold used to destroy the thing it was protecting.
   */
  @Post("listings/:id/market")
  async market(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "listings.review");
    if (denied(who)) return who;
    const action = String(b?.action ?? "");
    const to =
      action === "pause" ? "paused"
      : action === "resume" ? "live"
      : action === "withdraw" ? "withdrawn"
      : null;
    if (!to) return { error: "invalid", message: "Action must be pause, resume or withdraw." };

    const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
    const r = await moveListing(id, to, { reason: reason || null, reviewedBy: who.name });
    if (!r.ok) return { error: r.why };
    return { listing: await adminListing(id) };
  }

  /** A finding a rule cannot raise. Rule-derived flags are computed from the
   *  listing every time; these are the ones a person typed. */
  @Post("listings/:id/flags")
  async flags(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "listings.review");
    if (denied(who)) return who;
    const flags = Array.isArray(b?.flags)
      ? b.flags.map((f: any) => String(f).trim().slice(0, 200)).filter(Boolean).slice(0, 20)
      : undefined;
    await annotate(id, { flags, note: typeof b?.note === "string" ? b.note.slice(0, 2000) : undefined });
    return { listing: await adminListing(id) };
  }

  /* ======================================================= members / CRM */

  /**
   * The member directory.
   *
   * Filtered by the database rather than by the client. The console used to
   * hold every member in the bundle and cut them down in the browser, which is
   * fine at nine rows and not at nine thousand.
   */
  @Get("members")
  async members(
    @Req() req: Request,
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("plan") plan?: string,
    @Query("verification") verification?: string,
  ) {
    const who = await requireCapability(req, "members.read");
    if (denied(who)) return who;
    const members = await adminMembers({
      search: q?.trim() || null,
      status: status ?? null,
      plan: plan ?? null,
      verification: verification ?? null,
    });
    return { members };
  }

  /** One member, with the history the feature set asks to be in one place. */
  @Get("members/:id")
  async member(@Param("id") id: string, @Req() req: Request) {
    const who = await requireCapability(req, "members.read");
    if (denied(who)) return who;
    const [member, timeline] = await Promise.all([adminMember(id), memberTimeline(id)]);
    if (!member) return { error: "not-found" };
    return { member, timeline };
  }

  /**
   * Restrict, suspend, or put someone back.
   *
   * A restriction with no reason is not a decision, it is a shrug — and the
   * member has to be told something. Same rule as a listing rejection.
   */
  @Post("members/:id/standing")
  async standing(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "members.act");
    if (denied(who)) return who;

    const standing = String(b?.standing ?? "");
    if (!["active", "restricted", "revoked"].includes(standing)) {
      return { error: "invalid", message: "Standing must be active, restricted or revoked." };
    }
    const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
    if (standing !== "active" && reason.length < 4) {
      return { error: "no-reason", message: "Say why. It goes on the member's record." };
    }
    const ok = await setStanding(id, standing as MemberStatus, reason, who.name);
    if (!ok) return { error: "not-found" };
    return { member: await adminMember(id) };
  }

  /** Internal labels and the staff note. Never visible to the member. */
  @Post("members/:id/notes")
  async memberNotes(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "members.act");
    if (denied(who)) return who;
    const tags = Array.isArray(b?.tags)
      ? b.tags.map((t: any) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20)
      : undefined;
    const ok = await annotateMember(id, {
      tags,
      note: typeof b?.note === "string" ? b.note.slice(0, 2000) : undefined,
    });
    if (!ok) return { error: "not-found" };
    return { member: await adminMember(id) };
  }

  /* ============================================================ the team */

  @Get("staff")
  async staff(@Req() req: Request) {
    const who = await requireCapability(req, "team.read");
    if (denied(who)) return who;
    return { staff: await adminStaff() };
  }

  /** Invite, scope, revoke — one write, and only an owner may take it. */
  @Post("staff/:id/role")
  async staffRole(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "settings.write");
    if (denied(who)) return who;
    const role = String(b?.role ?? "");
    if (!isRole(role)) return { error: "invalid", message: `${role} is not a console role.` };
    if (id === who.userId && role === "member") {
      // Removing your own last owner role locks the console for everybody.
      return { error: "self-revoke", message: "You cannot remove your own console access." };
    }
    const ok = await setRole(id, role, who.name);
    if (!ok) return { error: "not-found" };
    return { staff: await adminStaff() };
  }

  /* ================================================== reports & conduct */

  @Get("cases")
  async cases(
    @Req() req: Request,
    @Query("state") state?: string,
    @Query("party") party?: string,
  ) {
    const who = await requireCapability(req, "conduct.decide");
    if (denied(who)) return who;
    const [cases, counts] = await Promise.all([
      adminCases({ state: state ?? null, party: party ?? null }),
      caseCounts(),
    ]);
    return { cases, counts };
  }

  @Get("cases/:id")
  async oneCase(@Param("id") id: string, @Req() req: Request) {
    const who = await requireCapability(req, "conduct.decide");
    if (denied(who)) return who;
    const [record, thread] = await Promise.all([adminCase(id), caseThread(id)]);
    if (!record) return { error: "not-found" };
    return { case: record, thread };
  }

  @Post("cases/:id/claim")
  async claimCaseRoute(@Param("id") id: string, @Req() req: Request) {
    const who = await requireCapability(req, "conduct.decide");
    if (denied(who)) return who;
    const ok = await claimCase(id, who.name);
    if (!ok) return { error: "not-found" };
    return { case: await adminCase(id) };
  }

  /** Move a case without deciding it — asking for evidence, or handing it up. */
  @Post("cases/:id/state")
  async caseState(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "conduct.decide");
    if (denied(who)) return who;
    const state = String(b?.state ?? "");
    if (!isState(state)) return { error: "invalid", message: `${state} is not a case state.` };
    const ok = await setCaseState(id, state);
    if (!ok) return { error: "not-found" };
    if (typeof b?.note === "string" && b.note.trim()) {
      await addCaseNote(id, who.name, b.note.trim().slice(0, 2000));
    }
    return { case: await adminCase(id) };
  }

  /**
   * The decision, and what it does to the person it lands on.
   *
   * Warn, restrict, close, refer to police — no refund among them, because no
   * money passes through the platform. `restricted` and `closed` also move the
   * member's standing, through `setStanding` rather than a second UPDATE here,
   * so there stays one place standing changes.
   */
  @Post("cases/:id/decision")
  async decideCaseRoute(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "conduct.decide");
    if (denied(who)) return who;

    const outcome = String(b?.outcome ?? "");
    if (!isOutcome(outcome)) {
      return { error: "invalid", message: `${outcome} is not a conduct outcome.` };
    }
    const note = typeof b?.note === "string" ? b.note.trim() : "";
    if (note.length < 4) {
      return { error: "no-reason", message: "A conduct decision needs a reason on the record." };
    }

    const record = await adminCase(id);
    if (!record) return { error: "not-found" };
    // Whom it lands on: the console may point it at either party, and defaults
    // to the person the case was raised against.
    const againstId = String(b?.againstId ?? record.against.id);
    if (![record.against.id, record.raisedBy.id].includes(againstId)) {
      return { error: "invalid", message: "That person is not a party to this case." };
    }

    await decideCase(id, { outcome, note, againstId, by: who.name });
    await addCaseNote(id, who.name, `Case closed: ${outcome}. ${note}`);

    if (outcome === "restricted") await setStanding(againstId, "restricted", note, who.name);
    if (outcome === "closed") await setStanding(againstId, "revoked", note, who.name);

    // The console tells the moderator both parties are told the outcome and
    // the reason. That has to be true where it is written, not somewhere else.
    for (const party of [record.raisedBy, record.against]) {
      await notify({
        userId: party.id,
        kind: "offer-settled",
        title: "Your case has been decided",
        body: note.slice(0, 200),
        href: `/dispute/${id}`,
      });
    }

    return { case: await adminCase(id) };
  }

  /**
   * One message to both sides at once.
   *
   * A case has two people in it, and half the work of moderating one is
   * telling them the same thing: what is still needed, or how long it will
   * take. Writing it twice is how the two answers end up saying different
   * things, so this is one line on the case thread that both of them read,
   * plus a notification each. It is not a decision and does not move the case.
   */
  @Post("cases/:id/message")
  async messageCase(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "conduct.decide");
    if (denied(who)) return who;

    const body = typeof b?.body === "string" ? b.body.trim() : "";
    if (body.length < 4) {
      return { error: "empty", message: "Write the message before sending it." };
    }

    const record = await adminCase(id);
    if (!record) return { error: "not-found" };

    const ok = await addCaseNote(id, who.name, `Grail Market: ${body.slice(0, 2000)}`);
    if (!ok) return { error: "not-found" };

    for (const party of [record.raisedBy, record.against]) {
      await notify({
        userId: party.id,
        kind: "message",
        title: "A moderator has written on your case",
        body: body.slice(0, 120),
        href: `/dispute/${id}`,
      });
    }
    return { case: await adminCase(id), thread: await caseThread(id) };
  }

  /* ========================================================= subscriptions */

  /**
   * Plans, boosts and billing in one read.
   *
   * One call rather than three: the page draws all three tabs from it, and
   * three round trips to fill one screen is three chances for the tabs to
   * disagree about what this month looks like.
   */
  @Get("commerce")
  async commerce(@Req() req: Request) {
    const who = await requireCapability(req, "billing.read");
    if (denied(who)) return who;
    const [plans, boosts, billing] = await Promise.all([
      adminPlans(),
      boostLedger(),
      billingLedger(),
    ]);
    return { plans, boosts, billing, boostTiers: BOOST_TIERS };
  }

  /** Start a boost that was charged for and never ran, extended by the days
   *  it spent waiting. */
  @Post("boosts/:id/apply")
  async applyBoostRoute(@Param("id") id: string, @Req() req: Request) {
    const who = await requireCapability(req, "billing.read");
    if (denied(who)) return who;
    const r = await applyBoost(id);
    if (!r) return { error: "not-found" };
    if (!r.ok) {
      return { error: "already-settled", message: "That boost has already been applied or comped." };
    }
    const boost = await adminBoost(id);
    if (boost) {
      await notify({
        userId: boost.userId,
        kind: "listing",
        title: "Your boost is running",
        body: `${boost.tierName} on ${boost.card}, extended by ${r.daysAdded} day${r.daysAdded === 1 ? "" : "s"} for the delay.`,
        href: `/listing/${boost.listingId}`,
      });
    }
    return { boost, daysAdded: r.daysAdded };
  }

  /** Give the boost away rather than charge for it. Filed with a name on it. */
  @Post("boosts/:id/comp")
  async compBoostRoute(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "billing.read");
    if (denied(who)) return who;
    const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
    if (reason.length < 6) {
      return { error: "no-reason", message: "A comp costs real revenue. Say why." };
    }
    const ok = await compBoost(id, who.name, reason.slice(0, 1000));
    if (!ok) {
      return { error: "already-settled", message: "That boost has already been comped." };
    }
    return { boost: await adminBoost(id) };
  }

  /** One billing cycle given away. Not a standing arrangement. */
  @Post("plans/:id/comp")
  async compPlanRoute(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "billing.read");
    if (denied(who)) return who;
    if (!planExists(id)) return { error: "invalid", message: `${id} is not a plan.` };

    const memberId = String(b?.memberId ?? "").trim();
    const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
    if (!memberId) return { error: "invalid", message: "Name the member it is for." };
    if (reason.length < 6) {
      return { error: "no-reason", message: "A comp costs real revenue. Say why." };
    }

    const months = Number(b?.months) > 0 ? Math.min(12, Math.floor(Number(b.months))) : 1;
    const ok = await compPlan({ userId: memberId, planId: id, months, reason: reason.slice(0, 1000), by: who.name });
    if (!ok) return { error: "not-found", message: "No account with that id." };

    await notify({
      userId: memberId,
      kind: "listing",
      title: "A month on us",
      body: reason.slice(0, 120),
      href: "/plans",
    });
    return { plans: await adminPlans() };
  }

  /* =========================================================== price engine */

  /**
   * Where every quoted figure comes from.
   *
   * The three tabs of the page: whether the sources are still delivering,
   * which (card, grader, grade) sets we hold a figure for, and what has been
   * held out of one. The sales under each set are fetched per set, on demand —
   * five rows for sixty sets is a payload nobody reads.
   */
  @Get("price-engine")
  async priceEngine(@Req() req: Request) {
    const who = await requireCapability(req, "pricing.read");
    if (denied(who)) return who;
    const [feeds, sets, excluded] = await Promise.all([
      feedHealth(),
      gradeSets(),
      excludedComps(),
    ]);
    return { feeds, sets, excluded };
  }

  /** The confirmed sales under one figure, and the middle of the ones that
   *  count. */
  @Get("price-engine/comps")
  async priceComps(
    @Req() req: Request,
    @Query("catalogId") catalogId?: string,
    @Query("grader") grader?: string,
    @Query("grade") grade?: string,
  ) {
    const who = await requireCapability(req, "pricing.read");
    if (denied(who)) return who;
    if (!catalogId) return { error: "invalid", message: "Which card?" };
    // Never a grade without a grading company — invariant 1. A request naming
    // one and not the other is refused rather than quietly widened.
    if (Boolean(grader) !== Boolean(grade)) {
      return {
        error: "invalid",
        message: "A grade belongs to a grading company. Ask for both, or for neither.",
      };
    }
    const comps = await compsFor(catalogId, grader ?? null, grade ?? null);
    return { comps, median: medianOf(comps) };
  }

  /** Keep a sale out of the quoted figure, or put it back in. The ledger row
   *  itself is never touched — see the store. */
  @Post("price-engine/comps/:saleId")
  async ruleComp(@Param("saleId") saleId: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "pricing.read");
    if (denied(who)) return who;
    const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
    if (reason.length < 6) {
      return {
        error: "no-reason",
        message: "Say what the sale actually was. It is what the next person reads.",
      };
    }
    const ok = await ruleOnComp(saleId, {
      excluded: Boolean(b?.excluded),
      reason: reason.slice(0, 1000),
      by: who.name,
    });
    if (!ok) return { error: "not-found", message: "No sale on the ledger with that id." };
    return { excluded: await excludedComps() };
  }

  /* =========================================================== support desk */

  @Get("tickets")
  async tickets(@Req() req: Request, @Query("status") status?: string) {
    const who = await requireCapability(req, "support.read");
    if (denied(who)) return who;
    const [tickets, counts] = await Promise.all([
      adminTickets({ status: status ?? null }),
      ticketCounts(),
    ]);
    return { tickets, counts, replyTarget: REPLY_TARGET };
  }

  /** One ticket: the conversation, and what else the member has going on. */
  @Get("tickets/:id")
  async ticket(@Param("id") id: string, @Req() req: Request) {
    const who = await requireCapability(req, "support.read");
    if (denied(who)) return who;
    const ticket = await adminTicket(id);
    if (!ticket) return { error: "not-found" };
    const [thread, context] = await Promise.all([
      ticketThread(id),
      /* Tier 1 sees the ticket and nothing else. The feature set gives trade
         context to Tier 2 and above, "for the ticket in hand" — so the panel
         is not fetched for an account that may not read it. */
      who.can("members.read") || who.role === "tier-2"
        ? ticketContext(ticket.member.id)
        : Promise.resolve({ listings: [], cases: [] }),
    ]);
    return { ticket, thread, context };
  }

  /**
   * A reply, or an internal note.
   *
   * The first reply stops the first-reply clock and moves a new ticket to
   * open. An internal note does neither: it is never sent to the member, so
   * it cannot count as having answered them.
   */
  @Post("tickets/:id/reply")
  async reply(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "support.reply");
    if (denied(who)) return who;
    const body = typeof b?.body === "string" ? b.body.trim() : "";
    if (body.length < 2) return { error: "empty", message: "Write something first." };
    const ok = await replyToTicket(
      id,
      { id: who.userId, name: who.name },
      body.slice(0, 8000),
      Boolean(b?.internal),
    );
    if (!ok) return { error: "not-found" };
    return { ticket: await adminTicket(id), thread: await ticketThread(id) };
  }

  /**
   * Move a ticket.
   *
   * Escalation only goes up — Tier 1 to Tier 2 to Trust and safety — because
   * the feature set says so, and because a ticket that can move back down is
   * a ticket that can be handed in a circle.
   */
  @Post("tickets/:id/state")
  async ticketState(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "support.reply");
    if (denied(who)) return who;

    const patch: { status?: string; priority?: string; tier?: string; assignee?: string } = {};
    if (typeof b?.status === "string") {
      if (!isStatus(b.status)) return { error: "invalid", message: `${b.status} is not a state.` };
      patch.status = b.status;
    }
    if (typeof b?.priority === "string") {
      if (!isPriority(b.priority)) {
        return { error: "invalid", message: `${b.priority} is not a priority.` };
      }
      patch.priority = b.priority;
    }
    if (typeof b?.tier === "string") {
      if (!isTier(b.tier)) return { error: "invalid", message: `${b.tier} is not a tier.` };
      const current = await adminTicket(id);
      if (!current) return { error: "not-found" };
      if (TIERS.indexOf(b.tier as never) < TIERS.indexOf(current.tier as never)) {
        return {
          error: "invalid",
          message: "Escalations move up, never back down. Reassign it instead.",
        };
      }
      patch.tier = b.tier;
    }
    if (b?.assign === true) patch.assignee = who.name;

    const ok = await setTicket(id, patch);
    if (!ok) return { error: "not-found" };
    return { ticket: await adminTicket(id) };
  }

  /** Raised by an agent on a member's behalf — the third intake route. */
  @Post("tickets")
  async openTicketRoute(@Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "support.reply");
    if (denied(who)) return who;
    const memberId = String(b?.memberId ?? "");
    const subject = String(b?.subject ?? "").trim();
    const body = String(b?.body ?? "").trim();
    if (!memberId || subject.length < 3 || body.length < 3) {
      return { error: "invalid", message: "A member, a subject and a first message are needed." };
    }
    const id = await openTicket({
      memberId,
      subject: subject.slice(0, 200),
      body: body.slice(0, 8000),
      category: typeof b?.category === "string" ? b.category.slice(0, 60) : undefined,
      priority: typeof b?.priority === "string" && isPriority(b.priority) ? b.priority : undefined,
      by: who.name,
    });
    if (!id) return { error: "no-store" };
    return { ticket: await adminTicket(id) };
  }
}
