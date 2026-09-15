// What a listing looks like to somebody who is not its seller.
//
// This was a denylist — `{ views, saves, reject_reason, ...rest }` — and a
// denylist only knows about the columns that existed when it was written.
// The admin review workflow added `moderator_note`, `moderator_flags`,
// `claimed_by`, `reviewed_by`, `submitted_at` and friends afterwards, and
// every one of them went straight to anonymous callers of GET /listings,
// GET /listings/:id and GET /sellers/:id. "Seller has two strikes" is not
// something a buyer browsing the marketplace should be able to read.
//
// So it is an allowlist: a new column is private until somebody decides it
// belongs on the public page and adds it here.

import { roundKm } from "./nearby.js";

const PUBLIC_FIELDS = [
  "listing_id", "seller_id", "catalog_id",
  "card_name", "set_name", "card_number", "game", "image_url",
  "grader", "grade", "label_grade", "cert_number", "is_raw",
  "variant", "language", "edition", "finish",
  "condition_note", "price", "currency", "market_value",
  "delivery", "suburb", "status",
  "photos", "video_url", "photo_verified",
  "created_at", "live_at", "sold_at",
] as const;

export function publicListing(l: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of PUBLIC_FIELDS) if (k in l) out[k] = l[k];
  out.featured = l.featured_until != null && new Date(l.featured_until) > new Date();
  // Only when the caller sent their own location. Whole kilometres, and never
  // the point it was measured from — `suburb_lat`/`suburb_lon` stay private by
  // not being in the list above.
  if ("distance_km" in l) out.distance_km = roundKm(l.distance_km);
  return out;
}
