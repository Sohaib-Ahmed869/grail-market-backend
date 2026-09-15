import { storePool } from "../cards.store.js";
import { geocode, type Point } from "../meetups/places.js";

// How far a listing is from the person looking at it.
//
// Selling here is local: no escrow, no shipping by default, the meet-up is
// the transaction. So "2 km away" is the fact a buyer decides on, and the
// home screen leads with it.
//
// A listing carries its seller's SUBURB, never an address. The point stored
// for it is that suburb's centre as OpenStreetMap places it — the same
// precision the suburb name already publishes — and it never leaves the
// server: the public shape carries a rounded distance, not coordinates.
//
// The viewer's point arrives on the request, is rounded to about a kilometre
// before anything uses it, and is not stored.

/** Australia, generously boxed — Christmas Island to Norfolk Island is not
 *  the job, the mainland and Tasmania are. The geocoder answers for Australia
 *  only, so a point outside this could never be near a listing anyway. */
const AU = { latMin: -44.5, latMax: -9.0, lonMin: 112.0, lonMax: 154.5 };

/** The viewer's point from the query string, or null.
 *
 *  Rounded to two decimals (about a kilometre) on the way in: distances are
 *  shown in whole kilometres, so finer precision would be a more exact record
 *  of where somebody is standing, bought for nothing. */
export function parseNear(lat: unknown, lon: unknown): Point | null {
  if (lat == null || lon == null || lat === "" || lon === "") return null;
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (la < AU.latMin || la > AU.latMax || lo < AU.lonMin || lo > AU.lonMax) return null;
  return { lat: Math.round(la * 100) / 100, lon: Math.round(lo * 100) / 100 };
}

/** A radius in km from the query string, or null for "anywhere". Capped: a
 *  "nearby" that reaches across the continent is not nearby. */
export function parseWithin(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : null;
}

/** Whole kilometres, as shown. Under one is 0 and the app says "under 1 km";
 *  a missing point stays null, which is "we don't know", not "right here". */
export function roundKm(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Great-circle distance from ($lat, $lon) to the listing's suburb, in SQL,
 *  so the database can order and filter a page by it. `least(1, …)` because
 *  floating point can put the haversine term a hair over 1 for two identical
 *  points, and asin of that is NaN. Null when the listing has no point. */
export function distanceSql(latParam: number, lonParam: number): string {
  const lat = `$${latParam}::float8`, lon = `$${lonParam}::float8`;
  return `(2 * 6371 * asin(least(1, sqrt(
      power(sin(radians(suburb_lat - ${lat}) / 2), 2)
    + cos(radians(${lat})) * cos(radians(suburb_lat))
    * power(sin(radians(suburb_lon - ${lon}) / 2), 2)))))`;
}

/** Place one listing's suburb now. Called after a create or an edit, without
 *  waiting on it, so the seller's request is never held by a map server. */
export async function locateListing(listingId: string): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  try {
    const r = await pool.query("select suburb from listings where listing_id = $1", [listingId]);
    await place(listingId, r.rows[0]?.suburb ?? null);
  } catch {
    /* best effort: the next browse fills it */
  }
}

let filling: Promise<void> | null = null;

/** Place a few listings that have no point for their current suburb.
 *
 *  Nothing runs on a schedule — the work rides on the requests that want the
 *  answer. Each call places at most `limit` listings; the geocoder spaces its
 *  own calls a second apart and keeps every answer a month, so a suburb is
 *  looked up once however many listings name it. One fill at a time, so two
 *  people opening the home screen together do not queue six lookups.
 *
 *  A suburb the map could not place is tried again a day later rather than on
 *  every request, or a handful of typos would take every slot forever. */
export function fillListingPoints(limit = 3): Promise<void> {
  if (filling) return filling;
  const pool = storePool();
  if (!pool) return Promise.resolve();
  filling = (async () => {
    try {
      const r = await pool.query(
        `select listing_id, suburb from listings
          where status = 'live' and coalesce(suburb, '') <> ''
            and suburb_geocoded is distinct from suburb
            and (suburb_checked_at is null or suburb_checked_at < now() - interval '1 day')
          order by suburb_checked_at nulls first, live_at desc
          limit $1`,
        [limit],
      );
      for (const row of r.rows) await place(row.listing_id, row.suburb);
    } catch {
      /* best effort */
    } finally {
      filling = null;
    }
  })();
  return filling;
}

async function place(listingId: string, suburb: string | null): Promise<void> {
  const pool = storePool();
  if (!pool) return;
  if (!suburb || !suburb.trim()) {
    await pool.query(
      `update listings set suburb_lat = null, suburb_lon = null, suburb_geocoded = null,
         suburb_checked_at = now() where listing_id = $1`,
      [listingId],
    );
    return;
  }
  const p = await geocode(suburb);
  // `suburb_geocoded` records WHICH suburb the point belongs to, so an edited
  // suburb is noticed as unplaced instead of keeping the old suburb's point.
  await pool.query(
    p
      ? `update listings set suburb_lat = $2, suburb_lon = $3, suburb_geocoded = $4,
           suburb_checked_at = now() where listing_id = $1`
      : `update listings set suburb_checked_at = now() where listing_id = $1`,
    p ? [listingId, p.lat, p.lon, suburb] : [listingId],
  );
}
