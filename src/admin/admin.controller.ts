import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { getListing, moveListing } from "../listings/store.js";
import { notify } from "../notifications/store.js";
import { tokensFor } from "../push/store.js";
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
import { setRole, userByEmail } from "./store.js";
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
  cachePlan, compBoost, compPlan, planCatalog, planExists,
} from "./commerce.store.js";
import { findPlan, priceIdFor } from "../billing/plans.js";
import {
  archivePrice, createPrice, getPrice, getProduct, setDefaultPrice,
  stripeConfigured, updateProduct,
} from "../billing/stripe.js";
import {
  compsFor, excludedComps, feedHealth, gradeSets, medianOf, ruleOnComp,
} from "./pricing.store.js";
import { isPeriod, reportsFor } from "./reports.store.js";
import { attention } from "./attention.store.js";
import { dashboard } from "./dashboard.store.js";
import { readSettings, writeSettings } from "./settings.store.js";
import { auditActors, auditEntries, auditTotals, isArea, writeAudit } from "./audit.store.js";
import {
  allAnnouncements, audiences, getAnnouncement, isChannel, isSegment, isTone,
  liveBanner, publish, setState as setAnnouncementState, type Channel,
} from "./announce.store.js";

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

  /**
   * What has gone past a line, for the bell in the topbar.
   *
   * Derived on every read, never stored. An alert that has to be created and
   * then dismissed goes stale the moment somebody else does the work, and two
   * operators end up looking at different bells; read again, and this is
   * current by construction.
   *
   * Only `requireStaff`, not a capability: every row here links to a page the
   * reader may or may not be able to open, and cutting the list to the role
   * would need one capability check per row for a handful of counts. What it
   * exposes is how much work is late, which every console role can already
   * see on the pages themselves.
   */
  /**
   * Everything the dashboard draws, in one read.
   *
   * It was the last page quoting sample money — ~4,900 subscribers from a
   * fixture, where `/admin/pricing` read the real number off the database.
   * Two pages of one console disagreeing about the same figure is worse than
   * either being wrong alone.
   */
  @Get("dashboard")
  async dashboard(@Req() req: Request) {
    const who = await requireStaff(req);
    if (denied(who)) return who;
    return dashboard();
  }

  @Get("attention")
  async attention(@Req() req: Request) {
    const who = await requireStaff(req);
    if (denied(who)) return who;
    return { items: await attention() };
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

    void writeAudit({
      actorId: who.userId,
      actor: by,
      area: "listing",
      action:
        to === "live" ? "Approved a listing"
        : to === "rejected" ? "Rejected a listing"
        : "Requested more from the seller",
      target: before.card_name,
      detail: reason || null,
      // A rejection ends somebody's sale and is filed on their record; an
      // approval is the queue working normally.
      weight: to === "live" ? "normal" : "high",
    });

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
    const before = await getListing(id);
    const r = await moveListing(id, to, { reason: reason || null, reviewedBy: who.name });
    if (!r.ok) return { error: r.why };

    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "listing",
      action:
        to === "paused" ? "Paused a listing"
        : to === "live" ? "Put a listing back on the market"
        : "Withdrew a listing",
      target: before?.card_name ?? id,
      detail: reason || null,
      // Withdrawing is final and kills the listing. Pausing gives it back.
      weight: to === "withdrawn" ? "high" : "normal",
    });
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
    const note = typeof b?.note === "string" ? b.note.slice(0, 2000) : undefined;
    await annotate(id, { flags, note });

    const l = await adminListing(id);
    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "listing",
      action: "Flagged a listing",
      target: l?.card ?? id,
      detail: [flags?.join(", "), note].filter(Boolean).join(" · ") || null,
      weight: "normal",
    });
    return { listing: l };
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

    const m = await adminMember(id);
    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "member",
      action:
        standing === "restricted" ? "Restricted an account"
        : standing === "revoked" ? "Revoked marketplace access"
        : "Put an account back in good standing",
      target: m?.handle ?? id,
      detail: reason || null,
      weight: "high",
    });
    return { member: m };
  }

  /** Internal labels and the staff note. Never visible to the member. */
  @Post("members/:id/notes")
  async memberNotes(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "members.act");
    if (denied(who)) return who;
    const tags = Array.isArray(b?.tags)
      ? b.tags.map((t: any) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20)
      : undefined;
    const note = typeof b?.note === "string" ? b.note.slice(0, 2000) : undefined;
    const ok = await annotateMember(id, { tags, note });
    if (!ok) return { error: "not-found" };

    const m = await adminMember(id);
    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "member",
      action: note !== undefined ? "Wrote an internal note on a member" : "Changed a member's labels",
      target: m?.handle ?? id,
      // The note itself, because "wrote a note" without the note is a
      // timestamp. It is internal either way — the member never sees it.
      detail: note ? note.slice(0, 1000) : tags ? tags.join(", ") : null,
      weight: "normal",
    });
    return { member: m };
  }

  /**
   * Write to members, from the console.
   *
   * This is the one that used to be a lie. The directory's "Message this
   * segment" button closed its dialog and showed a toast, and the per-member
   * Message button had no handler at all — so the console offered two ways to
   * contact somebody and neither sent anything.
   *
   * It goes through `notify`, the same path every other event in the system
   * uses, which means one row per member in `notifications` and a push where
   * the member has a device registered. It reports back how many of each,
   * separately, because those are different facts: a notification is in the
   * app when they next open it, a push is on their lock screen now, and a
   * member with no device registered gets the first and not the second.
   */
  @Post("members/message")
  async messageMembers(@Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "members.act");
    if (denied(who)) return who;

    const ids: string[] = Array.isArray(b?.memberIds)
      ? [...new Set((b.memberIds as unknown[]).map((x) => String(x)))].slice(0, 2000)
      : [];
    const subject = typeof b?.subject === "string" ? b.subject.trim() : "";
    const body = typeof b?.body === "string" ? b.body.trim() : "";

    if (ids.length === 0) return { error: "invalid", message: "Nobody to write to." };
    if (subject.length < 3) return { error: "invalid", message: "A subject is needed." };
    if (body.length < 10) return { error: "invalid", message: "Write the message first." };

    let delivered = 0;
    let pushed = 0;
    const failed: string[] = [];

    for (const id of ids) {
      try {
        /* Asked before sending rather than after: `notify` swallows its own
           push failures by design, so it cannot tell us afterwards whether
           there was a device to push to. */
        const tokens = await tokensFor(id).catch(() => []);
        await notify({
          userId: id,
          kind: "message",
          title: subject.slice(0, 200),
          body: body.slice(0, 2000),
          href: "/notifications",
        });
        delivered += 1;
        if (tokens.length > 0) pushed += 1;
      } catch {
        failed.push(id);
      }
    }

    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "member",
      action:
        ids.length === 1 ? "Wrote to a member" : `Wrote to ${ids.length} members`,
      target: subject,
      detail: `${delivered} in-app, ${pushed} pushed to a device.`,
      // One member is correspondence; a broadcast to a segment is not.
      weight: ids.length > 1 ? "high" : "normal",
    });

    return { delivered, pushed, failed: failed.length, of: ids.length };
  }

  /* ============================================================ settings */

  /**
   * The operational knobs.
   *
   * Every one of these was a `useState` in the settings page: typed into a
   * form, applied to nothing, and gone on reload. They are stored now, and the
   * defaults live beside them so a value nobody has set and a value that will
   * not parse give the same safe answer.
   *
   * Readable by anyone with a console role — the thresholds describe rules
   * every operator works under. Writing is `settings.write`.
   */
  @Get("settings")
  async settings(@Req() req: Request) {
    const who = await requireStaff(req);
    if (denied(who)) return who;
    return { settings: await readSettings(), canEdit: who.can("settings.write") };
  }

  @Post("settings")
  async saveSettings(@Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "settings.write");
    if (denied(who)) return who;

    const changed = await writeSettings(b ?? {}, who.name);
    if (changed.length > 0) {
      void writeAudit({
        actorId: who.userId,
        actor: who.name,
        area: "settings",
        action: `Changed ${changed.length} setting${changed.length === 1 ? "" : "s"}`,
        /* Named, so the entry can be checked against something. "Settings
           updated" is a timestamp, not an audit trail. */
        target: changed.join(", "),
        weight: "normal",
      });
    }
    return { settings: await readSettings(), changed };
  }

  /* ============================================================ the team */

  @Get("staff")
  async staff(@Req() req: Request) {
    const who = await requireCapability(req, "team.read");
    if (denied(who)) return who;
    return { staff: await adminStaff() };
  }

  /**
   * Give an existing account a console role.
   *
   * This is what "invite" actually is here, and the difference matters. There
   * is no way to create an account from the console — a person signs up like
   * anybody else and is then granted a role, which is why `users.role` is a
   * column rather than a separate staff table: a member IS a staff member with
   * a role on them, and revoking is one UPDATE rather than two records to keep
   * in step.
   *
   * So an address with no account behind it is refused, by name, rather than
   * queued as a pending invitation that nothing will ever deliver.
   */
  @Post("staff/grant")
  async grantStaff(@Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "settings.write");
    if (denied(who)) return who;

    const email = String(b?.email ?? "").trim().toLowerCase();
    const role = String(b?.role ?? "");
    if (!email.includes("@")) return { error: "invalid", message: "That is not an email address." };
    if (!isRole(role) || role === "member") {
      return { error: "invalid", message: `${role} is not a console role.` };
    }

    const found = await userByEmail(email);
    if (!found) {
      return {
        error: "no-account",
        message: `Nobody has signed up with ${email}. They need an account before it can be given a role.`,
      };
    }

    const ok = await setRole(found.userId, role, who.name);
    if (!ok) return { error: "not-found" };

    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "staff",
      action: `Granted the ${ROLE_LABEL[role]} role`,
      target: `${found.name} · ${email}`,
      detail: typeof b?.why === "string" && b.why.trim() ? b.why.trim().slice(0, 1000) : null,
      weight: "high",
    });
    return { staff: await adminStaff() };
  }

  /** Scope and revoke — one write, and only an owner may take it. */
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

    const team = await adminStaff();
    const person = team.find((x) => x.id === id);
    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "staff",
      action: role === "member" ? "Revoked console access" : `Granted the ${ROLE_LABEL[role]} role`,
      // A revoked account is no longer on the team list, so its name has to be
      // read before the write or the entry is left pointing at an id.
      target: person ? `${person.name} · ${person.email}` : id,
      weight: "high",
    });
    return { staff: team };
  }

  /* ======================================================== the audit log */

  /**
   * Who did what, and the reason they recorded at the time.
   *
   * Read-only, and there is deliberately no route that edits or removes an
   * entry. The page says "nothing here can be edited or deleted by anyone"
   * underneath itself, and that has to be true of the API rather than of the
   * screen — a console that hides a delete button still has one.
   *
   * Filtering is the database's job. The console used to hold the whole log in
   * the bundle and cut it down in the browser, which is fine at thirteen rows
   * and not at the seven years of retention the page promises.
   */
  @Get("audit")
  async audit(
    @Req() req: Request,
    @Query("area") area?: string,
    @Query("actor") actor?: string,
    @Query("weight") weight?: string,
    @Query("q") q?: string,
  ) {
    const who = await requireCapability(req, "audit.read");
    if (denied(who)) return who;
    const [entries, actors, totals] = await Promise.all([
      auditEntries({
        area: area && isArea(area) ? area : null,
        actor: actor ?? null,
        weight: weight ?? null,
        search: q?.trim() || null,
      }),
      auditActors(),
      auditTotals(),
    ]);
    return { entries, actors, totals };
  }

  /* ====================================================== announcements */

  /**
   * Everything broadcast, queued or currently on the app.
   *
   * The audience counts come back with it. The compose screen promises a
   * number before anybody presses send, and counting it in the browser off a
   * bundled member list is how that number ends up being about a different set
   * of people than the send is.
   */
  @Get("announcements")
  async announcements(@Req() req: Request) {
    const who = await requireCapability(req, "announce.write");
    if (denied(who)) return who;
    const [list, banner, segments] = await Promise.all([
      allAnnouncements(),
      liveBanner(),
      audiences(),
    ]);
    return { announcements: list, banner, segments };
  }

  /**
   * Send it, or queue it.
   *
   * What is recorded is what was sent and to how many. Nothing is dispatched:
   * push and email both need a provider that is not wired, so every row comes
   * back `delivered: false` and the console says so rather than implying a
   * member received anything. Saying "sent to 5,218" when nothing left the
   * building is the failure this endpoint is careful about.
   */
  @Post("announcements")
  async announce(@Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "announce.write");
    if (denied(who)) return who;

    const title = String(b?.title ?? "").trim();
    const body = String(b?.body ?? "").trim();
    if (title.length < 4 || body.length < 10) {
      return { error: "invalid", message: "A title and a message are both needed." };
    }

    /* Deduplicated, because the compose screen has three independent toggles
       and a repeated channel would be sent twice. */
    const named: string[] = Array.isArray(b?.channels)
      ? (b.channels as unknown[]).map((c) => String(c))
      : [];
    const channels: Channel[] = [...new Set(named)].filter(isChannel);
    if (channels.length === 0) {
      return { error: "invalid", message: "Pick at least one channel." };
    }

    const tone = typeof b?.tone === "string" && isTone(b.tone) ? b.tone : "info";
    const audience = typeof b?.audience === "string" && isSegment(b.audience) ? b.audience : "all";
    const when = b?.when === "later" ? "later" : "now";
    if (when === "later" && !b?.at) {
      return { error: "invalid", message: "Say when it goes out." };
    }
    // A time already past is not a schedule, it is a send nobody asked for.
    if (when === "later" && new Date(String(b.at)).getTime() <= Date.now()) {
      return { error: "invalid", message: "That time has already passed." };
    }

    const a = await publish({
      title, body, channels, audience, tone, when,
      at: b?.at ?? null,
      until: b?.until ?? null,
      byName: who.name,
      byId: who.userId,
    });
    if (!a) return { error: "no-store" };

    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "settings",
      action: a.state === "scheduled" ? "Scheduled an announcement" : "Sent an announcement",
      target: a.title,
      detail: `${a.channels.join(" + ")} · ${a.audience === "all" ? "everyone" : a.audience}${
        a.reach === undefined ? "" : ` · ${a.reach} accounts`
      }`,
      weight: "high",
    });
    return { announcement: a };
  }

  /** Pull a queued send, or take the live banner down. Nothing is deleted —
   *  a broadcast that was queued and pulled is a thing that happened, and the
   *  audit entry would otherwise point at a row that is gone. */
  @Post("announcements/:id/state")
  async announcementState(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "announce.write");
    if (denied(who)) return who;

    const state = String(b?.state ?? "");
    if (state !== "cancelled" && state !== "taken-down") {
      return { error: "invalid", message: "A send can be cancelled, or a banner taken down." };
    }

    const before = await getAnnouncement(id);
    if (!before) return { error: "not-found" };

    const a = await setAnnouncementState(id, state);
    if (!a) {
      return {
        error: "already-settled",
        message: "That announcement has already gone out or been pulled.",
      };
    }

    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "settings",
      action: state === "cancelled" ? "Cancelled a queued announcement" : "Took the banner down",
      target: a.title,
      weight: "normal",
    });
    return { announcement: a };
  }

  /* ================================================== reports & conduct */

  /**
   * The reporting page, in one read.
   *
   * Every figure is an aggregate computed now, over the period asked for —
   * there is no reports table, because a stored count is stale the moment
   * anything writes and this page's only value is that it can be checked
   * against the queues it summarises.
   *
   * A period the console does not offer falls back to 30 days rather than
   * erroring: the query string is a preference, not a command, and a bad one
   * should not leave a moderator staring at an error page.
   */
  @Get("reports")
  async reports(@Req() req: Request, @Query("period") period?: string) {
    const who = await requireCapability(req, "reports.read");
    if (denied(who)) return who;
    return reportsFor(period && isPeriod(period) ? period : "30d");
  }

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
    const note = typeof b?.note === "string" ? b.note.trim() : "";
    if (note) await addCaseNote(id, who.name, note.slice(0, 2000));

    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "conduct",
      action:
        state === "awaiting-evidence" ? "Asked a case for evidence"
        : state === "escalated" ? "Escalated a case"
        : state === "resolved" ? "Closed a case"
        : "Reopened a case",
      target: (await adminCase(id))?.against.handle ?? id,
      detail: note || null,
      weight: "normal",
    });
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

    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "conduct",
      action:
        outcome === "warned" ? "Recorded a formal warning"
        : outcome === "restricted" ? "Restricted an account on a case"
        : outcome === "closed" ? "Closed an account on a case"
        : outcome === "police" ? "Referred a case to police"
        : "Closed a case with no action",
      target:
        againstId === record.against.id
          ? `${record.against.handle}, raised by ${record.raisedBy.handle}`
          : `${record.raisedBy.handle}, who raised it against ${record.against.handle}`,
      detail: note,
      // Only "no action" leaves the person where it found them.
      weight: outcome === "none" ? "normal" : "high",
    });

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

    /* Reported back rather than assumed. The console used to say "sent to both
       parties" on the strength of having tried, which is not the same claim —
       a member with no device registered gets it in the app and not on their
       lock screen, and that is worth being able to see. */
    let delivered = 0;
    let pushed = 0;
    for (const party of [record.raisedBy, record.against]) {
      const tokens = await tokensFor(party.id).catch(() => []);
      await notify({
        userId: party.id,
        kind: "message",
        title: "A moderator has written on your case",
        body: body.slice(0, 120),
        href: `/dispute/${id}`,
      });
      delivered += 1;
      if (tokens.length > 0) pushed += 1;
    }
    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "conduct",
      action: "Wrote to both parties on a case",
      target: `${record.raisedBy.handle} and ${record.against.handle}`,
      detail: body.slice(0, 1000),
      weight: "normal",
    });

    return {
      case: await adminCase(id),
      thread: await caseThread(id),
      delivery: { delivered, pushed, of: 2 },
    };
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
    return {
      plans,
      boosts,
      billing,
      boostTiers: BOOST_TIERS,
      /* Whether the console may edit anything here at all. Without a secret
         key every plan control is a button that cannot work, and the page
         says so rather than failing on the click. */
      stripe: { configured: stripeConfigured(), canEdit: who.can("settings.write") },
    };
  }

  /**
   * Read the plans back from Stripe.
   *
   * The console caches what Stripe says so opening the page is not three round
   * trips; this is what fills that cache. It is a read against Stripe and a
   * write to our own table — it changes nothing at Stripe's end, which is why
   * it needs only `billing.read`.
   */
  @Post("plans/sync")
  async syncPlans(@Req() req: Request) {
    const who = await requireCapability(req, "billing.read");
    if (denied(who)) return who;
    if (!stripeConfigured()) {
      return { error: "no-stripe", message: "STRIPE_SECRET_KEY is not set on the API." };
    }

    const problems: string[] = [];
    const cat = await planCatalog();

    for (const plan of ["starter", "collector", "dealer"]) {
      const def = findPlan(plan);
      if (!def) continue;
      /* The price we already know about, or the one the environment names. A
         plan that has neither has never been configured, and is reported
         rather than silently skipped. */
      const priceId = cat.get(plan)?.priceId || priceIdFor(def);
      if (!priceId) {
        problems.push(`${def.name}: ${def.priceEnv} is not set and nothing is cached.`);
        continue;
      }
      try {
        const price = await getPrice(priceId);
        const product = await getProduct(price.product);
        await cachePlan({
          planId: plan,
          productId: product.id,
          priceId: price.id,
          amountCents: price.unit_amount,
          currency: price.currency,
          interval: price.recurring?.interval ?? "month",
          name: product.name,
          description: product.description,
          updatedBy: who.name,
        });
      } catch (e) {
        problems.push(`${def.name}: ${(e as Error).message}`);
      }
    }

    return { plans: await adminPlans(), problems };
  }

  /**
   * Edit a plan, at Stripe.
   *
   * The name and the description are a plain update — a Stripe product is
   * mutable. The amount is not: a Stripe price is immutable, so changing what
   * a plan costs means creating a NEW price on the same product, pointing the
   * product at it, and archiving the old one. That is three calls and it is
   * the only way; there is no update-in-place to write.
   *
   * What this deliberately does NOT do is re-price anybody already subscribed.
   * Existing subscriptions keep the price they were created against until each
   * one is migrated, which is Stripe's behaviour and not something to paper
   * over — the console says it on the confirm step, because "changed the
   * price" reads as "everybody now pays this" and it does not mean that.
   *
   * `settings.write` rather than `billing.read`: this is the only control in
   * the console that changes what a member is charged.
   */
  @Post("plans/:id")
  async editPlan(@Param("id") id: string, @Req() req: Request, @Body() b: any) {
    const who = await requireCapability(req, "settings.write");
    if (denied(who)) return who;
    if (!planExists(id)) return { error: "invalid", message: `${id} is not a plan.` };
    if (!stripeConfigured()) {
      return { error: "no-stripe", message: "STRIPE_SECRET_KEY is not set on the API." };
    }

    const def = findPlan(id)!;
    const cat = await planCatalog();
    const known = cat.get(id);
    const priceId = known?.priceId || priceIdFor(def);
    if (!priceId) {
      return {
        error: "not-configured",
        message: `${def.name} has no Stripe price yet. Set ${def.priceEnv} and sync first.`,
      };
    }

    const name = typeof b?.name === "string" ? b.name.trim() : "";
    const description = typeof b?.blurb === "string" ? b.blurb.trim() : "";
    // Whole currency units in, smallest unit out. Exactly one place converts.
    const dollars = b?.price === undefined || b?.price === null ? null : Number(b.price);
    if (dollars !== null && (!Number.isFinite(dollars) || dollars < 0 || dollars > 100_000)) {
      return { error: "invalid", message: "That is not a monthly price." };
    }
    if (name && name.length < 2) {
      return { error: "invalid", message: "A plan needs a name." };
    }

    try {
      let price = await getPrice(priceId);
      const productId = price.product;

      if (name || description) {
        await updateProduct(productId, {
          name: name || undefined,
          description: description || undefined,
        });
      }

      const wanted = dollars === null ? null : Math.round(dollars * 100);
      if (wanted !== null && wanted !== price.unit_amount) {
        const next = await createPrice({
          product: productId,
          unitAmount: wanted,
          currency: price.currency,
          interval: price.recurring?.interval ?? "month",
        });
        await setDefaultPrice(productId, next.id);
        /* Archived, not deleted: the subscriptions created against it still
           reference it, and their invoices have to keep resolving. */
        await archivePrice(price.id).catch(() => null);
        price = next;
      }

      const product = await getProduct(productId);
      await cachePlan({
        planId: id,
        productId: product.id,
        priceId: price.id,
        amountCents: price.unit_amount,
        currency: price.currency,
        interval: price.recurring?.interval ?? "month",
        name: product.name,
        description: product.description,
        updatedBy: who.name,
      });

      void writeAudit({
        actorId: who.userId,
        actor: who.name,
        area: "billing",
        action:
          wanted !== null && wanted !== known?.amountCents
            ? "Changed a plan price at Stripe"
            : "Edited a plan at Stripe",
        target: product.name,
        detail:
          wanted === null
            ? "Name and description only."
            : `${(wanted / 100).toFixed(2)} ${price.currency.toUpperCase()} a ${
                price.recurring?.interval ?? "month"
              }. A new price was created; existing subscribers keep the one they signed up on.`,
        weight: "high",
      });

      return { plans: await adminPlans() };
    } catch (e) {
      /* Stripe's own wording, forwarded. "No such product" is actionable;
         "the request failed" is not. */
      return { error: "stripe", message: (e as Error).message };
    }
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
    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "billing",
      action: "Applied a paid boost that never ran",
      target: boost ? `${boost.handle} · ${boost.card}` : id,
      detail: `Extended by ${r.daysAdded} day${r.daysAdded === 1 ? "" : "s"} for the delay.`,
      weight: "high",
    });
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
    const comped = await adminBoost(id);
    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "billing",
      action: "Comped a boost",
      target: comped ? comped.handle : id,
      detail: reason.slice(0, 1000),
      weight: "high",
    });
    return { boost: comped };
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
    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "billing",
      action: `Comped ${months} month${months === 1 ? "" : "s"} of a plan`,
      target: `${id} · ${(await adminMember(memberId))?.handle ?? memberId}`,
      detail: reason.slice(0, 1000),
      weight: "high",
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

    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "pricing",
      action: Boolean(b?.excluded)
        ? "Excluded a sale as an outlier"
        : "Put an excluded sale back into the figure",
      target: saleId,
      detail: reason.slice(0, 1000),
      weight: "normal",
    });
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

    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "support",
      action: Boolean(b?.internal) ? "Added an internal note to a ticket" : "Replied to a ticket",
      target: (await adminTicket(id))?.subject ?? id,
      weight: "normal",
    });
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

    const t = await adminTicket(id);
    /* Assigning a ticket to yourself is not worth an audit entry — it is who
       is holding it, not a decision about anybody. An escalation or a state
       change is. */
    const worth = patch.status || patch.priority || patch.tier;
    if (worth) {
      void writeAudit({
        actorId: who.userId,
        actor: who.name,
        area: "support",
        action: patch.tier
          ? `Escalated a ticket to ${patch.tier}`
          : patch.status
            ? `Moved a ticket to ${patch.status}`
            : `Set a ticket to ${patch.priority} priority`,
        target: t?.subject ?? id,
        weight: "normal",
      });
    }
    return { ticket: t };
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

    void writeAudit({
      actorId: who.userId,
      actor: who.name,
      area: "support",
      action: "Raised a ticket for a member",
      target: subject.slice(0, 200),
      weight: "normal",
    });
    return { ticket: await adminTicket(id) };
  }
}
