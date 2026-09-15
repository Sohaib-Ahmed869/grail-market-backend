import { randomUUID } from "node:crypto";
import { storePool } from "../cards.store.js";
import { censor } from "../community/censor.js";
import { notify } from "../notifications/store.js";
import { readSettings } from "../admin/settings.store.js";
import { moveListing } from "../listings/store.js";
import {
  canComment, canRaise, canResolve, canWithdraw, isOutcome, statusAfterComment,
  type Deal, type Outcome, type ReasonCode, type Status,
} from "./rules.js";

// Disputes, and the evidence attached to them.
//
// The thread is a separate table rather than a json column on the dispute:
// evidence is the point of the feature, and something that decides a refund
// wants rows that can be counted, ordered and pointed at — not a blob that
// has to be parsed to answer "what did the seller actually say".

export const DISPUTES_SCHEMA = `
CREATE TABLE IF NOT EXISTS disputes (
  dispute_id  text PRIMARY KEY,
  listing_id  text NOT NULL,
  raised_by   text NOT NULL,
  against_id  text NOT NULL,
  raiser_role text NOT NULL,
  reason      text NOT NULL,
  detail      text,
  status      text NOT NULL DEFAULT 'open',
  outcome     text,
  outcome_note text,
  resolved_by text,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS disputes_listing ON disputes (listing_id);
CREATE INDEX IF NOT EXISTS disputes_party ON disputes (raised_by, created_at DESC);
CREATE INDEX IF NOT EXISTS disputes_against ON disputes (against_id, created_at DESC);
-- Open disputes first, because that is the only view anybody works from.
CREATE INDEX IF NOT EXISTS disputes_open ON disputes (status, created_at DESC);

CREATE TABLE IF NOT EXISTS dispute_events (
  event_id   text PRIMARY KEY,
  dispute_id text NOT NULL,
  author_id  text NOT NULL,
  -- 'comment' | 'evidence' | 'status'. A status row is written by the system
  -- so the thread reads as a history rather than needing the dispute's
  -- columns cross-referenced against timestamps.
  kind       text NOT NULL DEFAULT 'comment',
  body       text,
  photos     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispute_events_thread ON dispute_events (dispute_id, created_at);

-- Marketplace policy's "Pause on report": which of the reported member's
-- listings this dispute took off the market, so they can be given back when
-- (and only when) it is safe to — see resumeAutoPausedListings() below. Not
-- a column on listings itself: a listing can be paused for more than one
-- open dispute against the same seller, and the row has to know which cases
-- are still holding it down rather than a single "paused by" pointer that
-- the first case to close would overwrite.
CREATE TABLE IF NOT EXISTS dispute_pauses (
  dispute_id text NOT NULL,
  listing_id text NOT NULL,
  paused_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dispute_id, listing_id)
);
CREATE INDEX IF NOT EXISTS dispute_pauses_listing ON dispute_pauses (listing_id);
`;

export async function initDisputes(): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  await pool.query(DISPUTES_SCHEMA);
}

/** At most six. Evidence is photographs of a card and its packaging, and
 *  past half a dozen it is someone attaching their camera roll. */
const MAX_PHOTOS = 6;
const cleanPhotos = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u))
    .slice(0, MAX_PHOTOS);

/** The trade behind a listing, and any dispute already on it. */
async function dealFor(listingId: string, userId: string): Promise<
  (Deal & { soldDaysAgo: number | null; cardName: string }) | null
> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select l.status as listing_status, l.seller_id, l.card_name,
            o.buyer_id, o.status as offer_status,
            extract(epoch from (now() - l.sold_at)) / 86400 as sold_days_ago,
            (select d.status from disputes d
              where d.listing_id = l.listing_id
              order by d.created_at desc limit 1) as existing_status
       from listings l
       left join offers o
         on o.listing_id = l.listing_id and o.status = 'accepted'
      where l.listing_id = $1`,
    [listingId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    listingStatus: row.listing_status,
    sellerId: row.seller_id,
    buyerId: row.buyer_id ?? null,
    offerStatus: row.offer_status ?? "none",
    existingStatus: (row.existing_status as Status | null) ?? null,
    soldDaysAgo: row.sold_days_ago == null ? null : Math.floor(Number(row.sold_days_ago)),
    cardName: row.card_name,
  };
}

export type RaiseResult =
  | { ok: true; disputeId: string }
  | { ok: false; why: string; message: string };

export async function raiseDispute(a: {
  listingId: string; userId: string; reason: string;
  detail?: string | null; photos?: unknown;
}): Promise<RaiseResult> {
  const pool = storePool();
  if (!pool) return { ok: false, why: "no-store", message: "Unavailable right now." };

  const deal = await dealFor(a.listingId, a.userId);
  if (!deal) return { ok: false, why: "not-found", message: "That listing doesn't exist." };

  // Marketplace policy's own "Reporting window" — how long after a trade one
  // member can still report the other. `RAISE_WINDOW_DAYS` in rules.ts is only
  // the fallback for when nobody has set one.
  const settings = await readSettings();
  const v = canRaise(a.userId, deal, a.reason, deal.soldDaysAgo, settings.reportWindowDays);
  if (!v.ok) {
    const message: Record<string, string> = {
      "not-party": "You weren't part of this deal.",
      self: "You can't open a dispute with yourself.",
      "no-deal": deal.soldDaysAgo != null && deal.soldDaysAgo > settings.reportWindowDays
        ? `This sale is more than ${settings.reportWindowDays} days old. Get in touch and we'll look at it directly.`
        : "You can open a dispute once the card has changed hands.",
      "already-open": "There's already an open dispute on this sale.",
      "already-resolved": "This one has been settled. Get in touch if something's changed.",
      "bad-reason": "Pick a reason from the list.",
    };
    return { ok: false, why: v.why, message: message[v.why] };
  }

  const id = `d_${randomUUID().slice(0, 12)}`;
  const photos = cleanPhotos(a.photos);
  // Censored like every other free-text field. A dispute is read by the other
  // party and by staff, which makes it one more place a phone number can be
  // slipped into a conversation that is meant to stay on the platform.
  const detail = a.detail ? censor(a.detail).text.slice(0, 2000) : null;

  await pool.query(
    `insert into disputes
       (dispute_id, listing_id, raised_by, against_id, raiser_role, reason, detail)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [id, a.listingId, a.userId, v.against, v.role, a.reason, detail],
  );
  if (detail || photos.length) {
    await pool.query(
      `insert into dispute_events (event_id, dispute_id, author_id, kind, body, photos)
       values ($1,$2,$3,$4,$5,$6)`,
      [`e_${randomUUID().slice(0, 12)}`, id, a.userId,
       photos.length ? "evidence" : "comment", detail, JSON.stringify(photos)],
    );
  }

  // "Pause the reported member's listings when a case opens." A side effect
  // of the report, not of the underlying account, so it must never be able
  // to stop the report itself from being recorded.
  if (settings.pauseOnReport) {
    await pauseListingsFor(v.against, id).catch((err) => {
      console.warn("[disputes] pause-on-report failed:", (err as Error).message);
    });
  }

  await notify({
    userId: v.against, kind: "offer-settled", actorId: a.userId,
    title: "A dispute was opened on your sale",
    body: `${deal.cardName} — you have a chance to respond.`,
    href: `/dispute/${id}`,
  });
  return { ok: true, disputeId: id };
}

/** Take the reported member's live listings off the market, and remember
 *  which ones so `resumeAutoPausedListings` can give back exactly these and
 *  nothing the seller paused themselves. */
async function pauseListingsFor(sellerId: string, disputeId: string): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  const r = await pool.query(
    "select listing_id from listings where seller_id = $1 and status = 'live'",
    [sellerId],
  );
  for (const row of r.rows) {
    const listingId = row.listing_id as string;
    const moved = await moveListing(listingId, "paused", {
      reason: "Automatically paused — a dispute was opened against this seller.",
    });
    if (moved.ok) {
      await pool.query(
        `insert into dispute_pauses (dispute_id, listing_id) values ($1, $2)
         on conflict (dispute_id, listing_id) do nothing`,
        [disputeId, listingId],
      );
    }
  }
}

/**
 * Give back whatever this dispute paused, once it closes — "until the case
 * closes", as the setting says. Only what THIS dispute is the last thing
 * holding down: a listing paused for two open disputes against the same
 * seller stays paused until both are done, and a listing the seller has
 * since withdrawn or sold is left exactly where it is.
 *
 * Safe to call from more than one place a case can close (a decision, a
 * bare state change, a withdrawal) and safe to call twice on the same
 * dispute — there is nothing left to resume the second time.
 */
export async function resumeAutoPausedListings(disputeId: string): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  try {
    const r = await pool.query(
      "select listing_id from dispute_pauses where dispute_id = $1",
      [disputeId],
    );
    for (const row of r.rows) {
      const listingId = row.listing_id as string;
      // Closed either way a case can close: the admin console decides through
      // `conduct_cases.state` and never touches `disputes.status`, while the
      // seller/staff path in this file is the other way round — so a listing
      // only counts as still blocked when NEITHER says the other case is done.
      const still = await pool.query(
        `select 1
           from dispute_pauses dp
           join disputes d on d.dispute_id = dp.dispute_id
      left join conduct_cases c on c.dispute_id = dp.dispute_id
          where dp.listing_id = $1
            and dp.dispute_id <> $2
            and d.status not in ('resolved', 'withdrawn')
            and coalesce(c.state, 'open') <> 'resolved'`,
        [listingId, disputeId],
      );
      if ((still.rowCount ?? 0) > 0) continue;
      await moveListing(listingId, "live", {
        reason: "Automatically resumed — the case that paused it has closed.",
      });
    }
  } catch (err) {
    console.warn("[disputes] resume-on-close failed:", (err as Error).message);
  }
}

export type DisputeRow = {
  dispute_id: string; listing_id: string; raised_by: string; against_id: string;
  raiser_role: string; reason: ReasonCode; detail: string | null;
  status: Status; outcome: Outcome | null; outcome_note: string | null;
  created_at: string; updated_at: string;
  card_name?: string; image_url?: string | null; price?: string | null;
};

export async function getDispute(
  id: string, viewerId: string,
): Promise<{ dispute: DisputeRow; events: any[] } | null> {
  const pool = storePool();
  if (!pool) return null;
  const r = await pool.query(
    `select d.*, l.card_name, l.image_url, l.price
       from disputes d join listings l on l.listing_id = d.listing_id
      where d.dispute_id = $1`,
    [id],
  );
  const dispute = r.rows[0];
  if (!dispute) return null;
  // Only the two parties. Staff read it through the admin surface, which has
  // its own route — this one answers "not found" rather than "not allowed",
  // so a dispute id cannot be probed for existence.
  if (viewerId !== dispute.raised_by && viewerId !== dispute.against_id) return null;

  const e = await pool.query(
    `select event_id, author_id, kind, body, photos, created_at
       from dispute_events where dispute_id = $1 order by created_at`,
    [id],
  );
  return { dispute, events: e.rows };
}

/** Every dispute this person is on either side of. */
export async function myDisputes(userId: string): Promise<DisputeRow[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select d.*, l.card_name, l.image_url, l.price
       from disputes d join listings l on l.listing_id = d.listing_id
      where d.raised_by = $1 or d.against_id = $1
      order by
        -- live ones first, then most recent: a settled dispute from March is
        -- never the thing you opened this screen to find.
        case when d.status in ('open','answered') then 0 else 1 end,
        d.created_at desc
      limit 50`,
    [userId],
  );
  return r.rows;
}

export async function addEvent(a: {
  disputeId: string; userId: string; body?: string | null; photos?: unknown;
}): Promise<{ ok: true; status: Status } | { ok: false; message: string }> {
  const pool = storePool();
  if (!pool) return { ok: false, message: "Unavailable right now." };
  const r = await pool.query(
    "select raised_by, against_id, status from disputes where dispute_id = $1",
    [a.disputeId],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, message: "That dispute doesn't exist." };

  const d = { raisedBy: row.raised_by, against: row.against_id, status: row.status as Status };
  if (!canComment(a.userId, d)) {
    return {
      ok: false,
      message: d.status === "resolved" || d.status === "withdrawn"
        ? "This dispute is closed."
        : "You aren't part of this dispute.",
    };
  }

  const photos = cleanPhotos(a.photos);
  const body = a.body ? censor(a.body).text.slice(0, 2000) : null;
  if (!body && !photos.length) return { ok: false, message: "Add a note or a photo." };

  await pool.query(
    `insert into dispute_events (event_id, dispute_id, author_id, kind, body, photos)
     values ($1,$2,$3,$4,$5,$6)`,
    [`e_${randomUUID().slice(0, 12)}`, a.disputeId, a.userId,
     photos.length ? "evidence" : "comment", body, JSON.stringify(photos)],
  );

  const next = statusAfterComment(a.userId, d);
  await pool.query(
    "update disputes set status = $2, updated_at = now() where dispute_id = $1",
    [a.disputeId, next],
  );

  const other = a.userId === d.raisedBy ? d.against : d.raisedBy;
  await notify({
    userId: other, kind: "message", actorId: a.userId,
    title: "New activity on your dispute",
    body: body ? body.slice(0, 120) : `${photos.length} photo${photos.length === 1 ? "" : "s"} added`,
    href: `/dispute/${a.disputeId}`,
  });
  return { ok: true, status: next };
}

export async function withdrawDispute(
  id: string, userId: string,
): Promise<{ ok: boolean; message?: string }> {
  const pool = storePool();
  if (!pool) return { ok: false, message: "Unavailable right now." };
  const r = await pool.query(
    "select raised_by, against_id, status from disputes where dispute_id = $1", [id],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, message: "That dispute doesn't exist." };
  const d = { raisedBy: row.raised_by, against: row.against_id, status: row.status as Status };
  if (!canWithdraw(userId, d)) {
    return { ok: false, message: "Only the person who opened it can withdraw it." };
  }
  await pool.query(
    "update disputes set status = 'withdrawn', updated_at = now() where dispute_id = $1", [id],
  );
  await pool.query(
    `insert into dispute_events (event_id, dispute_id, author_id, kind, body)
     values ($1,$2,$3,'status','Withdrawn by the person who opened it.')`,
    [`e_${randomUUID().slice(0, 12)}`, id, userId],
  );
  await notify({
    userId: d.against, kind: "offer-settled", actorId: userId,
    title: "A dispute was withdrawn",
    body: "Nothing further is needed from you.",
    href: `/dispute/${id}`,
  });
  await resumeAutoPausedListings(id);
  return { ok: true };
}

/** Settle it. Staff with the conduct capability only, and never a party —
 *  see `canResolve`. `deciderIsStaff` is established by the route from the
 *  admin guard, not claimed by the caller. */
export async function resolveDispute(a: {
  disputeId: string; byUserId: string; outcome: string; note?: string | null;
  deciderIsStaff: boolean;
}): Promise<{ ok: boolean; message?: string }> {
  const pool = storePool();
  if (!pool) return { ok: false, message: "Unavailable right now." };
  if (!isOutcome(a.outcome)) return { ok: false, message: "Pick an outcome from the list." };

  const r = await pool.query(
    "select raised_by, against_id, status from disputes where dispute_id = $1", [a.disputeId],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, message: "That dispute doesn't exist." };
  const d = { raisedBy: row.raised_by, against: row.against_id, status: row.status as Status };
  if (!canResolve(a.byUserId, d, a.deciderIsStaff)) {
    return {
      ok: false,
      message: !a.deciderIsStaff
        ? "Only Grail Market staff can settle a dispute."
        : d.status === "resolved" || d.status === "withdrawn"
          ? "This one is already settled."
          : "A dispute can't be decided by either side of it.",
    };
  }

  const note = a.note ? censor(a.note).text.slice(0, 2000) : null;
  await pool.query(
    `update disputes
        set status = 'resolved', outcome = $2, outcome_note = $3,
            resolved_by = $4, resolved_at = now(), updated_at = now()
      where dispute_id = $1`,
    [a.disputeId, a.outcome, note, a.byUserId],
  );
  await pool.query(
    `insert into dispute_events (event_id, dispute_id, author_id, kind, body)
     values ($1,$2,$3,'status',$4)`,
    [`e_${randomUUID().slice(0, 12)}`, a.disputeId, a.byUserId,
     note ? `Resolved: ${a.outcome}. ${note}` : `Resolved: ${a.outcome}.`],
  );
  for (const who of [d.raisedBy, d.against]) {
    await notify({
      userId: who, kind: "offer-settled", actorId: a.byUserId,
      title: "Your dispute has been settled",
      body: note ?? `Outcome: ${a.outcome.replace(/-/g, " ")}.`,
      href: `/dispute/${a.disputeId}`,
    });
  }
  await resumeAutoPausedListings(a.disputeId);
  return { ok: true };
}
