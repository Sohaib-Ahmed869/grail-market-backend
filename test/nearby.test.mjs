import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { distanceSql, parseNear, parseWithin, roundKm } from "../src/listings/nearby.js";
import { publicListing } from "../src/listings/publicshape.js";

test("the viewer's point is rounded to about a kilometre before anything uses it", () => {
  // Surry Hills, to the precision a phone reports.
  assert.deepEqual(parseNear("-33.886123", "151.211987"), { lat: -33.89, lon: 151.21 });
  assert.deepEqual(parseNear(-42.8821, 147.3272), { lat: -42.88, lon: 147.33 }); // Hobart
});

test("a point that is missing, garbage or outside Australia gives no distances rather than wrong ones", () => {
  assert.equal(parseNear(undefined, "151.2"), null);
  assert.equal(parseNear("", ""), null);
  assert.equal(parseNear("abc", "151.2"), null);
  assert.equal(parseNear("51.5072", "-0.1276"), null); // London
  assert.equal(parseNear("33.88", "151.21"), null);    // the sign dropped: the northern hemisphere
  assert.equal(parseNear("0", "0"), null);             // a device that reported nothing
});

test("distances are whole kilometres; unknown stays unknown", () => {
  assert.equal(roundKm(2.4), 2);
  assert.equal(roundKm("3.6"), 4);
  assert.equal(roundKm(0.3), 0);
  // A listing with no point is not "right here".
  assert.equal(roundKm(null), null);
  assert.equal(roundKm(undefined), null);
  assert.equal(roundKm("NaN"), null);
});

test("a nearby radius is capped and never negative", () => {
  assert.equal(parseWithin("50"), 50);
  assert.equal(parseWithin("9000"), 500);
  assert.equal(parseWithin("-5"), null);
  assert.equal(parseWithin(""), null);
});

test("the SQL distance uses the parameters it is given and guards asin", () => {
  const sql = distanceSql(1, 2);
  assert.match(sql, /\$1::float8/);
  assert.match(sql, /\$2::float8/);
  assert.match(sql, /least\(1,/);
});

test("a buyer sees how far, never where the listing was placed", () => {
  const row = {
    listing_id: "l_1", seller_id: "u_1", card_name: "Charizard ex", suburb: "Newtown",
    status: "live", featured_until: null, price: "111",
    suburb_lat: -33.8977, suburb_lon: 151.1794, suburb_geocoded: "Newtown",
    suburb_checked_at: "2026-09-15", distance_km: 3.72,
  };
  const p = publicListing(row);
  assert.equal(p.distance_km, 4);
  for (const k of ["suburb_lat", "suburb_lon", "suburb_geocoded", "suburb_checked_at"]) {
    assert.ok(!(k in p), `${k} must not be public`);
  }
});

test("without a viewer location there is no distance field at all", () => {
  const p = publicListing({ listing_id: "l_2", suburb: "Newtown", featured_until: null });
  assert.ok(!("distance_km" in p));
});
