// The admin console's view of a listing.
//
// Everything here is the pure part: a database row in, the shape the console
// draws out. It needs no store, which is the point — the mapping is where a
// queue quietly starts disagreeing with the table under it, and that is worth
// pinning down without a Postgres to run it against.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminStatus,
  GRAIL_FLOOR,
  HIGH_VALUE_FLOOR,
  markOutliers,
  shape,
  SLA_HOURS,
  slaLeft,
} from "../src/admin/listings.store.js";
import { canMove } from "../src/listings/store.js";
import {
  can,
  capabilitiesOf,
  isStaff,
  roleOf,
  STAFF_ROLES,
} from "../src/admin/roles.js";

/** A minimal row, as `select l.*, …` would hand it back. */
const row = (over = {}) => ({
  listing_id: "l_test",
  card_name: "Charizard",
  set_name: "Base Set",
  variant: "holo",
  card_number: "4",
  game: "pokemon",
  grader: "PSA",
  grade: "10",
  cert_number: "88214417",
  is_raw: false,
  price: 18500,
  currency: "AUD",
  market_value: 17250,
  status: "in_review",
  photos: [],
  moderator_flags: [],
  views: 0,
  saves: 0,
  created_at: new Date("2026-09-01T00:00:00Z"),
  submitted_at: new Date("2026-09-01T00:00:00Z"),
  seller_id: "u_1",
  seller_name: "Daniel Wu",
  seller_identity: "Approved",
  seller_sales: 214,
  seller_reviews: 198,
  seller_rating: 4.9,
  comp_count: 0,
  comp_median: null,
  ...over,
});

/* ------------------------------------------------------------------ status */

test("an unclaimed listing in review is waiting on anybody; a claimed one is being worked", () => {
  // This is the whole reason the console has two words for one store status.
  // Collapsing them is how two moderators decide the same card.
  assert.equal(adminStatus(row({ status: "in_review", claimed_by: null })), "awaiting");
  assert.equal(adminStatus(row({ status: "in_review", claimed_by: "Ayna" })), "in-review");
});

test("every store status the console can be shown maps to one it can draw", () => {
  const seen = {
    in_review: "awaiting",
    info_requested: "info-requested",
    live: "live",
    sold: "sold",
    paused: "paused",
    rejected: "rejected",
    withdrawn: "withdrawn",
  };
  for (const [store, expected] of Object.entries(seen)) {
    assert.equal(adminStatus(row({ status: store, claimed_by: null })), expected, store);
  }
});

/* -------------------------------------------------------------------- tier */

test("the tier follows the ask, because that is what it is a statement about", () => {
  assert.equal(shape(row({ price: GRAIL_FLOOR })).tier, "grail");
  assert.equal(shape(row({ price: GRAIL_FLOOR - 1 })).tier, "high-value");
  assert.equal(shape(row({ price: HIGH_VALUE_FLOOR })).tier, "high-value");
  assert.equal(shape(row({ price: HIGH_VALUE_FLOOR - 1 })).tier, "standard");
});

/* ------------------------------------------------------------------- price */

test("a market figure from confirmed sales says so, and one from the listing says that instead", () => {
  // A moderator reading "$1,878 from 0 comparable sales" is being told two
  // contradictory things. The source is part of the answer.
  const withComps = shape(row({ comp_count: 12, comp_median: 17000 }));
  assert.equal(withComps.marketPrice, 17000);
  assert.equal(withComps.marketSource, "comps");
  assert.equal(withComps.sampleSize, 12);

  const fromListing = shape(row({ comp_count: 0, comp_median: null, market_value: 17250 }));
  assert.equal(fromListing.marketPrice, 17250);
  assert.equal(fromListing.marketSource, "listing");
  assert.equal(fromListing.sampleSize, 0);

  const nothing = shape(row({ comp_count: 0, comp_median: null, market_value: null }));
  assert.equal(nothing.marketPrice, 0);
  assert.equal(nothing.marketSource, "none");
});

test("confidence is a statement about the sample, never about the figure", () => {
  assert.equal(shape(row({ comp_count: 34, comp_median: 1 })).confidence, "high");
  assert.equal(shape(row({ comp_count: 20, comp_median: 1 })).confidence, "high");
  assert.equal(shape(row({ comp_count: 19, comp_median: 1 })).confidence, "medium");
  assert.equal(shape(row({ comp_count: 5, comp_median: 1 })).confidence, "medium");
  assert.equal(shape(row({ comp_count: 4, comp_median: 1 })).confidence, "low");
  // A figure carried over from the listing has no sample behind it at all.
  assert.equal(shape(row({ comp_count: 0, market_value: 17250 })).confidence, "low");
});

/* --------------------------------------------------------------------- SLA */

test("the review clock runs from submission, and only while it is waiting on us", () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
  assert.equal(slaLeft(row({ status: "in_review", submitted_at: twoHoursAgo })), SLA_HOURS - 2);

  // Over the target reads as negative, which is what the queue leads with.
  const longAgo = new Date(Date.now() - (SLA_HOURS + 6) * 3_600_000);
  assert.equal(slaLeft(row({ status: "in_review", submitted_at: longAgo })), -6);

  // Nothing else has a clock: a live listing is not late.
  for (const status of ["live", "sold", "rejected", "withdrawn", "info_requested"]) {
    assert.equal(slaLeft(row({ status, submitted_at: longAgo })), 0, status);
  }
});

test("a draft that predates the submitted_at column falls back to its creation time", () => {
  const created = new Date(Date.now() - 3 * 3_600_000);
  assert.equal(slaLeft(row({ status: "in_review", submitted_at: null, created_at: created })), SLA_HOURS - 3);
});

/* ---------------------------------------------------------------- outliers */

test("one bad sale is excluded rather than allowed to move the quoted price", () => {
  const sales = [
    { price: 1000 },
    { price: 1050 },
    { price: 980 },
    { price: 1020 },
    { price: 42000 },
  ];
  const marked = markOutliers(sales);
  assert.equal(marked.filter((s) => s.outlier).length, 1);
  assert.equal(marked.find((s) => s.outlier).price, 42000);
  assert.match(marked.find((s) => s.outlier).why, /above/i);
});

test("a low outlier is caught too — a fake sale is as often cheap as dear", () => {
  const marked = markOutliers([{ price: 1000 }, { price: 1050 }, { price: 980 }, { price: 1020 }, { price: 5 }]);
  const out = marked.filter((s) => s.outlier);
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 5);
  assert.match(out[0].why, /below/i);
});

test("a real spread is not an outlier — the test is distance, not disagreement", () => {
  const marked = markOutliers([{ price: 900 }, { price: 1000 }, { price: 1100 }, { price: 1250 }, { price: 800 }]);
  assert.equal(marked.filter((s) => s.outlier).length, 0);
});

test("under four sales nothing is flagged, because there is no spread to measure", () => {
  // Calling one of three sales a fake is a guess, and a moderator would act
  // on it. The rule is silence, not a smaller threshold.
  for (const n of [0, 1, 2, 3]) {
    const sales = [{ price: 1000 }, { price: 1010 }, { price: 990 }, { price: 90000 }].slice(0, n);
    assert.equal(markOutliers(sales).filter((s) => s.outlier).length, 0, `${n} sales`);
  }
});

test("identical sales do not all become outliers", () => {
  // The median absolute deviation is zero here, and dividing by it is how a
  // naive version flags every row in a set of five identical prices.
  const marked = markOutliers([{ price: 1000 }, { price: 1000 }, { price: 1000 }, { price: 1000 }]);
  assert.equal(marked.filter((s) => s.outlier).length, 0);
});

/* ------------------------------------------------------- the state machine */

test("the console's three decisions are all reachable from review, and live is not reachable otherwise", () => {
  assert.ok(canMove("in_review", "live"));
  assert.ok(canMove("in_review", "rejected"));
  assert.ok(canMove("in_review", "info_requested"));
  // The product's whole claim: nothing reaches a buyer without passing review.
  assert.equal(canMove("draft", "live"), false);
  assert.equal(canMove("info_requested", "live"), false);
  assert.equal(canMove("rejected", "live"), false);
});

test("pausing is reversible and withdrawing is not", () => {
  assert.ok(canMove("live", "paused"));
  assert.ok(canMove("paused", "live"));
  assert.ok(canMove("live", "withdrawn"));
  assert.equal(canMove("withdrawn", "live"), false);
  assert.equal(canMove("sold", "live"), false);
});

/* ------------------------------------------------------------------ shape */

test("a raw card is not given a grader it does not have", () => {
  const raw = shape(row({ is_raw: true, grader: null, grade: null, cert_number: null }));
  assert.equal(raw.grader, "Raw");
  assert.equal(raw.grade, "None");
  assert.equal(raw.cert, "—");
});

test("the set line is built from what is there, with no empty separators", () => {
  assert.equal(shape(row()).setLine, "Base Set · holo · #4");
  assert.equal(shape(row({ variant: null })).setLine, "Base Set · #4");
  assert.equal(shape(row({ set_name: null, variant: null, card_number: null })).setLine, "");
  // A seller who typed the hash themselves does not get two of them.
  assert.equal(shape(row({ card_number: "#4" })).setLine, "Base Set · holo · #4");
});

test("initials come from the ends of a name, not the first two words of it", () => {
  assert.equal(shape(row({ seller_name: "Daniel Wu" })).seller.initials, "DW");
  assert.equal(shape(row({ seller_name: "Mia de la Fontaine" })).seller.initials, "MF");
  assert.equal(shape(row({ seller_name: "Prince" })).seller.initials, "P");
  assert.equal(shape(row({ seller_name: null })).seller.initials, "US"); // "Unknown seller"
});

test("the photo count is the angles supplied, and an absent set is zero rather than a crash", () => {
  assert.equal(shape(row({ photos: [{ angle: "front", url: "a" }] })).photos, 1);
  assert.equal(shape(row({ photos: null })).photos, 0);
  assert.equal(shape(row({ photos: "not an array" })).photos, 0);
});

/* ------------------------------------------------------------------ roles */

test("an unknown role in the column is a member, never an owner", () => {
  // A typo, a role we removed, a null from an older row: all of them have to
  // fail closed. Failing open here hands the console to anyone with an account.
  for (const junk of [null, undefined, "", "admin", "OWNER", "owner ", 1, {}]) {
    assert.equal(roleOf(junk), "member", JSON.stringify(junk));
  }
  assert.equal(roleOf("owner"), "owner");
  assert.equal(roleOf("tier-1"), "tier-1");
});

test("a member has no console capability at all", () => {
  assert.deepEqual(capabilitiesOf("member"), []);
  for (const c of capabilitiesOf("owner")) {
    assert.equal(can("member", c), false, c);
  }
});

test("the outsourced desk sees its own queue and nothing else", () => {
  // Straight out of the feature set: "no ID data, no member records, no
  // listing tools". These four are the ones that claim depends on.
  for (const role of ["tier-1", "tier-2"]) {
    assert.ok(can(role, "support.read"), role);
    assert.ok(can(role, "support.reply"), role);
    assert.equal(can(role, "id.exceptions"), false, role);
    assert.equal(can(role, "members.read"), false, role);
    assert.equal(can(role, "listings.review"), false, role);
    assert.equal(can(role, "billing.read"), false, role);
  }
});

test("a moderator works the listing queue and touches neither billing nor ID", () => {
  assert.ok(can("moderator", "listings.review"));
  assert.ok(can("moderator", "members.read"));
  assert.equal(can("moderator", "billing.read"), false);
  assert.equal(can("moderator", "id.exceptions"), false);
  assert.equal(can("moderator", "settings.write"), false);
});

test("trust & safety holds the ID exceptions and conduct, and no listing queue", () => {
  assert.ok(can("trust-safety", "id.exceptions"));
  assert.ok(can("trust-safety", "conduct.decide"));
  assert.ok(can("trust-safety", "members.act"));
  assert.equal(can("trust-safety", "listings.review"), false);
  assert.equal(can("trust-safety", "settings.write"), false);
});

test("only the owner can reach the price engine, billing and the settings", () => {
  for (const cap of ["settings.write", "billing.read", "pricing.read", "announce.write"]) {
    const holders = ["member", "tier-1", "tier-2", "moderator", "trust-safety", "owner"]
      .filter((r) => can(r, cap));
    assert.deepEqual(holders, ["owner"], cap);
  }
});

test("every capability is held by somebody, and every role's list is a real capability", () => {
  // A capability nobody holds is a page nobody can open; a role listing one
  // that does not exist is a check that silently never passes.
  const all = capabilitiesOf("owner");
  for (const role of ["member", "tier-1", "tier-2", "moderator", "trust-safety", "owner"]) {
    for (const c of capabilitiesOf(role)) {
      assert.ok(all.includes(c), `${role} lists unknown capability ${c}`);
    }
  }
  for (const c of all) {
    assert.ok(can("owner", c), c);
  }
});

test("staff is everyone with a role that is not member", () => {
  assert.equal(isStaff("member"), false);
  for (const r of STAFF_ROLES) assert.ok(isStaff(r), r);
  assert.equal(STAFF_ROLES.includes("member"), false);
});
