import { storePool } from "../cards.store.js";

// "If the same card appears several times over a few months, raise it for
// review." — Ahmed, 11 September, recorded on GM001-59.
//
// The reason it is a fake signal rather than a housekeeping one: a counterfeit
// is not a single object. Somebody who has one genuine card sells it once;
// somebody with a stack of reprints lists the same card again every few weeks,
// and each listing looks perfectly ordinary on its own. The pattern is only
// visible across time, which is exactly what a per-listing review cannot see.
//
// Two signals, and they are not the same strength:
//
//   CERTIFICATE   A grading company issues a cert number to one physical slab.
//                 The same number on two live listings is not a pattern to
//                 weigh, it is a contradiction — at most one of them can be
//                 the card that number belongs to. Highest signal we have.
//
//   REPETITION    The same (card, grader, grade) from one seller, several
//                 times over a few months. Weaker on purpose: a dealer with
//                 genuine stock does this legitimately, so it raises a review
//                 rather than an accusation.
//
// Nothing here takes a listing down. It raises it for a person, per the
// wording requirement on that ticket — the product never tells a buyer a card
// is genuine, and it should not tell a seller theirs is fake either.

/** Several, over a few months. */
export const REPEAT_COUNT = 3;
export const REPEAT_WINDOW_DAYS = 90;

export type RepeatRow = {
  listingId: string;
  status: string;
  /** ISO; whichever of reviewed/submitted/created we have */
  at: string;
  certNumber: string | null;
  sameCert: boolean;
};

export type RepeatVerdict = {
  level: "none" | "review" | "conflict";
  reason: string | null;
  /** how many other listings of this same card by this seller, in window */
  occurrences: number;
  /** listings sharing this one's certificate number */
  certClashes: string[];
};

const DAY = 86_400_000;

/** Pure, so the window and the counting can be pinned by fixtures.
 *
 *  `rows` are OTHER listings of the same card by the same seller, plus any
 *  listing anywhere that carries this one's certificate number. */
export function repeatVerdict(rows: RepeatRow[], now: Date | number = Date.now()): RepeatVerdict {
  const t = new Date(now).getTime();

  // A cert clash is decided first and outranks everything: it does not need a
  // count or a window, because one number cannot be two slabs. Withdrawn and
  // rejected listings still count here — a seller who pulled a listing after
  // being asked about it has not made the clash go away.
  const certClashes = rows.filter((r) => r.sameCert).map((r) => r.listingId);
  if (certClashes.length) {
    return {
      level: "conflict",
      reason:
        `This certificate number is on ${certClashes.length + 1} listings. A grading ` +
        `company issues a cert to one card, so at most one of them is that card.`,
      occurrences: 0,
      certClashes,
    };
  }

  // Repetition counts only listings that actually reached the market. A draft
  // is a person changing their mind, and counting drafts would flag the
  // carefulness we want sellers to have.
  const counted = rows.filter(
    (r) =>
      !r.sameCert &&
      ["live", "reserved", "sold", "withdrawn"].includes(r.status) &&
      (t - new Date(r.at).getTime()) / DAY <= REPEAT_WINDOW_DAYS,
  );

  // +1 for the listing being reviewed: three OTHERS plus this one is four of
  // the same card, which is past "several" by any reading.
  const total = counted.length + 1;
  if (total >= REPEAT_COUNT) {
    return {
      level: "review",
      reason:
        `The same card at the same grade has been listed ${total} times by this seller ` +
        `in the last ${REPEAT_WINDOW_DAYS} days.`,
      occurrences: counted.length,
      certClashes: [],
    };
  }

  return { level: "none", reason: null, occurrences: counted.length, certClashes: [] };
}

/** The rows behind the verdict, for one listing under review.
 *
 *  Derived on read rather than stored, like every other rule-raised flag here
 *  — a stored flag goes stale the moment the seller lists again. */
export async function repeatSignals(listingId: string): Promise<RepeatRow[]> {
  const pool = storePool();
  if (!pool) return [];
  const r = await pool.query(
    `select o.listing_id, o.status, o.cert_number,
            coalesce(o.reviewed_at, o.submitted_at, o.created_at) as at,
            (l.cert_number is not null and o.cert_number = l.cert_number) as same_cert
       from listings l
       join listings o
         on o.listing_id <> l.listing_id
        and (
              -- the same card, same grade, from the same seller
              (o.seller_id = l.seller_id
               and o.catalog_id is not null and o.catalog_id = l.catalog_id
               and coalesce(o.grader,'') = coalesce(l.grader,'')
               and coalesce(o.grade,'')  = coalesce(l.grade,''))
           or -- or the same certificate, from ANYONE
              (l.cert_number is not null and o.cert_number = l.cert_number)
            )
      where l.listing_id = $1
      order by at desc
      limit 50`,
    [listingId],
  );
  return r.rows.map((x: any) => ({
    listingId: x.listing_id,
    status: x.status,
    at: new Date(x.at).toISOString(),
    certNumber: x.cert_number ?? null,
    sameCert: Boolean(x.same_cert),
  }));
}
