import { TtlCache } from "../scans/ttlcache.js";

// Where two people who have never met can safely hand over a card.
//
// GrailMarket moves no money and ships nothing: the meet-up IS the
// transaction. So where it happens is the main physical safety control the
// product has, and Ahmed asked for it on 11 September — suggest a card shop
// between the two parties, a public place with staff and cameras, while
// leaving them free to meet anywhere they like.
//
// Both data sources are OpenStreetMap and both are free: Nominatim turns a
// suburb into a point, Overpass lists the shops around a point. Their usage
// policies ask for an identifying User-Agent, modest request rates and
// caching, and every call below honours that. Nothing runs on a schedule;
// a lookup happens when somebody opens the meet-up step, and its answer is
// kept for days because shops do not move.
//
// The buyer's suburb is never stored. It arrives on the request, is turned
// into a point, and is forgotten with the response.

const UA = "GrailMarket/1.0 (+https://grailcard.com.au)";
const DAY = 24 * 3600 * 1000;

export type Point = { lat: number; lon: number };
export type Shop = {
  name: string; kind: "card" | "games"; lat: number; lon: number;
  address: string | null; website: string | null; openingHours: string | null;
};

// ---- pure ---------------------------------------------------------------------

const rad = (d: number) => (d * Math.PI) / 180;

export function distanceKm(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Plain average. Across the distances two people will drive to swap a card,
 *  the curvature of the earth is a rounding error. */
export const midpoint = (a: Point, b: Point): Point => ({ lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 });

const CARD_WORDS = /\b(cards?|tcg|ccg|pok[eé]mon|poke|magic|mtg|yu-?gi-?oh|one piece|lorcana|collectables?|collectibles?|good games|trading)\b/i;
/** Places tagged as a shop that are not somewhere to stand and hand over a card. */
const NOT_A_MEETING_PLACE = /\bgrading\b|\bexchange\b|warehouse|online|\bpost\b/i;

/** Is this OpenStreetMap element a place to meet, and what kind?
 *
 *  `card` — its name says trading cards, or it is a known card-game chain.
 *  `games` — a game shop that does not say cards; most of them sell them.
 *  Anything else — toy chains, model railway shops, anime merchandise, mail
 *  order "exchanges" — is not offered, because pointing two strangers at a
 *  Smiggle is not a safety feature. */
export function classifyShop(e: { tags?: Record<string, string> }): Shop["kind"] | null {
  const t = e.tags ?? {};
  const name = t.name ?? "";
  if (!name || NOT_A_MEETING_PLACE.test(name)) return null;
  if (CARD_WORDS.test(name)) return "card";
  if (t.shop === "games") return "games";
  return null;
}

/** Fairest first: the shop that asks the least of whichever of the two has
 *  further to go, with card shops ahead of general game shops at similar
 *  distances (within 2 km of each other counts as similar). */
export function rankShops<T extends { kind: Shop["kind"]; lat: number; lon: number }>(shops: T[], a: Point, b: Point): T[] {
  const worst = (s: T) => Math.max(distanceKm(a, s), distanceKm(b, s));
  return [...shops].sort((x, y) => {
    const dx = worst(x), dy = worst(y);
    if (Math.abs(dx - dy) > 2) return dx - dy;
    if (x.kind !== y.kind) return x.kind === "card" ? -1 : 1;
    return dx - dy;
  });
}

// ---- network ------------------------------------------------------------------

const geoCache = new TtlCache<Point | null>(30 * DAY, 5_000, "geocode");
let lastNominatim = 0;

/** A suburb, postcode or "suburb STATE" as a point in Australia, or null.
 *
 *  Nominatim allows one request a second from an application. Calls are
 *  spaced to that, and every answer — a miss included — is kept for a month,
 *  so each suburb is looked up once. */
export async function geocode(place: string): Promise<Point | null> {
  const q = place.trim().replace(/\s+/g, " ");
  if (q.length < 3 || q.length > 80) return null;
  const key = q.toLowerCase();
  const hit = geoCache.entry(key);
  if (hit) return hit.v;
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  try {
    const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
      q: `${q}, Australia`, countrycodes: "au", format: "json", limit: "1",
    })}`;
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;   // not cached: their bad minute is not a fact about the suburb
    const rows = (await r.json()) as { lat: string; lon: string }[];
    const p = rows[0] ? { lat: Number(rows[0].lat), lon: Number(rows[0].lon) } : null;
    geoCache.set(key, p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null);
    return geoCache.get(key) ?? null;
  } catch {
    return null;
  }
}

/** Shops by map tile, half a degree square — about 55 by 45 km around the
 *  Australian cities. Kept for thirty days and across restarts: a card shop
 *  does not move week to week, and the free map servers are the weakest
 *  link in this feature, so each tile is asked for once a month, not once
 *  per meet-up. */
const TILE = 0.5;
const tileCache = new TtlCache<Shop[]>(30 * DAY, 4_000, "meetup-tiles");
const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const inflight = new Map<string, Promise<Shop[] | null>>();

export const tileOf = (p: Point) => `${Math.floor(p.lat / TILE) * TILE}:${Math.floor(p.lon / TILE) * TILE}`;

/** The tiles a circle touches. */
export function tilesAround(p: Point, radiusKm: number): string[] {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.2, Math.cos(rad(p.lat))));
  const out = new Set<string>();
  for (const lat of [p.lat - dLat, p.lat, p.lat + dLat]) {
    for (const lon of [p.lon - dLon, p.lon, p.lon + dLon]) out.add(tileOf({ lat, lon }));
  }
  return [...out];
}

function parseShops(elements: any[]): Shop[] {
  const shops: Shop[] = [];
  for (const e of elements ?? []) {
    const kind = classifyShop(e);
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (!kind || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const t = e.tags ?? {};
    const address = [
      [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "),
      t["addr:suburb"] ?? t["addr:city"],
    ].filter(Boolean).join(", ") || null;
    shops.push({
      name: t.name, kind, lat, lon, address,
      website: t.website ?? t["contact:website"] ?? null,
      openingHours: t.opening_hours ?? null,
    });
  }
  return shops;
}

/** One tile from the map servers, both mirrors at once, first answer wins.
 *  A long server-side timeout, because this normally runs in the background
 *  and only once a month per tile. */
function fetchTile(tile: string): Promise<Shop[] | null> {
  const running = inflight.get(tile);
  if (running) return running;
  const [la, lo] = tile.split(":").map(Number) as [number, number];
  const bbox = `${la},${lo},${la + TILE},${lo + TILE}`;
  const query = `[out:json][timeout:60];nwr["shop"~"^(games|collector|hobby|comics|toys)$"](${bbox});out center tags;`;
  const ask = async (mirror: string) => {
    const res = await fetch(mirror, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(70_000),
    });
    if (!res.ok) throw new Error(`overpass ${res.status}`);
    return parseShops(((await res.json()) as { elements?: any[] }).elements ?? []);
  };
  const p = Promise.any(MIRRORS.map(ask))
    .then((shops) => { tileCache.set(tile, shops); return shops; })
    .catch(() => null)
    .finally(() => inflight.delete(tile));
  inflight.set(tile, p);
  return p;
}

/** Card and game shops within `radiusKm` of a point, from saved tiles.
 *
 *  Tiles already saved answer instantly. Missing ones are fetched — this
 *  request waits for them up to `waitMs`, and if the map servers are slower
 *  than that the fetch carries on in the background so the next person (or
 *  the same person a minute later) gets an instant answer. Null means no tile
 *  could be read at all, fresh or old. */
export async function shopsNear(p: Point, radiusKm: number, waitMs = 14_000): Promise<Shop[] | null> {
  const r = Math.min(Math.max(radiusKm, 2), 40);
  const tiles = tilesAround(p, r);
  const have: Shop[] = [];
  const missing: string[] = [];
  for (const t of tiles) {
    const hit = tileCache.get(t);
    if (hit) have.push(...hit); else missing.push(t);
  }
  let readable = tiles.length - missing.length;
  if (missing.length) {
    const timeout = new Promise<"late">((res) => setTimeout(() => res("late"), waitMs));
    const got = await Promise.all(missing.map((t) => Promise.race([fetchTile(t), timeout])));
    got.forEach((g, i) => {
      if (Array.isArray(g)) { have.push(...g); readable += 1; return; }
      // Late or failed: an expired copy of the tile is still where the shops are.
      const old = tileCache.stale(missing[i]!);
      if (old) { have.push(...old); readable += 1; }
    });
  }
  if (!readable) return null;
  const seen = new Set<string>();
  return have.filter((s) => {
    const k = `${s.name}:${s.lat.toFixed(4)}:${s.lon.toFixed(4)}`;
    if (seen.has(k) || distanceKm(p, s) > r) return false;
    seen.add(k);
    return true;
  });
}
