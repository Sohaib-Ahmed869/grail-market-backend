// The audit log and the announcement queue, on the parts that need no store.
//
// Both of these are mostly SQL, and SQL is not what goes quietly wrong here.
// What goes quietly wrong is the mapping: a row shaped into the console's
// words, and the validators that decide what a client is allowed to put in the
// table in the first place. Those are pure, and this pins them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AREAS, isArea, shape as shapeEntry } from "../src/admin/audit.store.js";
import {
  CHANNELS,
  isChannel,
  isSegment,
  isTone,
  shape as shapeAnnouncement,
} from "../src/admin/announce.store.js";

/* ============================================================= audit log */

test("every area the console draws an icon for is an area the API accepts", () => {
  // The console has a label and an icon per area; an area it can render and
  // the API rejects is a filter that silently returns nothing.
  for (const a of [
    "listing", "member", "conduct", "support", "billing", "pricing", "settings", "staff",
  ]) {
    assert.ok(isArea(a), `${a} should be an audit area`);
    assert.ok(AREAS.includes(a));
  }
});

test("an unknown area is not an area", () => {
  assert.equal(isArea("everything"), false);
  assert.equal(isArea(""), false);
  assert.equal(isArea("constructor"), false, "inherited keys are not areas");
});

const row = (over = {}) => ({
  entry_id: "au_1",
  at: new Date("2026-09-04T09:00:00Z"),
  actor: "Ayna Sulaiman",
  area: "listing",
  action: "Rejected a listing",
  target: "LS-9002",
  detail: "Print dot pattern inconsistent with 1952 Topps stock.",
  weight: "high",
  ...over,
});

test("a row becomes the entry the log draws", () => {
  const e = shapeEntry(row());
  assert.equal(e.id, "au_1");
  assert.equal(e.at, "2026-09-04T09:00:00.000Z");
  assert.equal(e.actor, "Ayna Sulaiman");
  assert.equal(e.area, "listing");
  assert.equal(e.weight, "high");
  assert.equal(e.detail, "Print dot pattern inconsistent with 1952 Topps stock.");
});

/* The reason recorded at the time is the whole value of an entry. A null must
   come out absent rather than as the string "null" in the middle of a page
   somebody is reading to settle a dispute. */
test("no reason recorded is absent, not the word null", () => {
  const e = shapeEntry(row({ detail: null }));
  assert.equal(e.detail, undefined);
});

/* A weight nobody recognises must not be treated as consequential: the page
   badges "high" in red, and over-claiming which decisions changed someone's
   standing is the wrong way to be wrong. */
test("an unrecognised weight falls to normal, never to high", () => {
  assert.equal(shapeEntry(row({ weight: "critical" })).weight, "normal");
  assert.equal(shapeEntry(row({ weight: null })).weight, "normal");
});

test("an unrecognised area still renders rather than blanking the row", () => {
  const e = shapeEntry(row({ area: "quantum" }));
  assert.ok(isArea(e.area), "shaped area must always be one the console can draw");
});

/* ========================================================= announcements */

test("only the three real channels are channels", () => {
  for (const c of CHANNELS) assert.ok(isChannel(c));
  assert.equal(isChannel("sms"), false);
  assert.equal(isChannel("Push"), false, "channels are lower case on the wire");
});

test("only the three real tones are tones", () => {
  assert.ok(isTone("info") && isTone("outage") && isTone("policy"));
  assert.equal(isTone("urgent"), false);
});

/* The segment decides who a broadcast is addressed to. An unknown key must not
   reach the SQL builder — the route falls back to everybody, and this is the
   check it falls back on. */
test("a segment the API does not define is not a segment", () => {
  for (const k of ["all", "lapsed", "never-listed", "unverified", "billing"]) {
    assert.ok(isSegment(k), `${k} should be a segment`);
  }
  assert.equal(isSegment("vips"), false);
  assert.equal(isSegment("toString"), false, "inherited keys are not segments");
});

const announcement = (over = {}) => ({
  announcement_id: "an_1",
  title: "Card scanning is slow this morning",
  body: "Scans are taking up to 30 seconds.",
  channels: ["banner"],
  audience: "all",
  tone: "outage",
  state: "live",
  at: new Date("2026-09-04T06:15:00Z"),
  until: null,
  by_name: "Ayna Sulaiman",
  reach: 5218,
  delivered: false,
  ...over,
});

test("a row becomes the announcement the history draws", () => {
  const a = shapeAnnouncement(announcement());
  assert.equal(a.id, "an_1");
  assert.deepEqual(a.channels, ["banner"]);
  assert.equal(a.state, "live");
  assert.equal(a.reach, 5218);
  assert.equal(a.until, undefined);
});

/* The one claim this page must not make. `delivered` is what stops "sent to
   5,218" meaning "5,218 people received it" while no dispatcher exists, so it
   must never default to true on a row that does not say so. */
test("delivered is false unless the row says otherwise", () => {
  assert.equal(shapeAnnouncement(announcement({ delivered: null })).delivered, false);
  assert.equal(shapeAnnouncement(announcement({ delivered: undefined })).delivered, false);
  assert.equal(shapeAnnouncement(announcement({ delivered: true })).delivered, true);
});

/* A reach of zero is a real answer — a segment with nobody in it — and must
   survive as 0 rather than being swallowed into "not counted". */
test("a reach of zero is a count, not a missing count", () => {
  assert.equal(shapeAnnouncement(announcement({ reach: 0 })).reach, 0);
  assert.equal(shapeAnnouncement(announcement({ reach: null })).reach, undefined);
});

test("a channel the table should never have held is dropped, not rendered", () => {
  const a = shapeAnnouncement(announcement({ channels: ["banner", "carrier-pigeon", "push"] }));
  assert.deepEqual(a.channels, ["banner", "push"]);
});

test("a null channel array is empty rather than a crash", () => {
  assert.deepEqual(shapeAnnouncement(announcement({ channels: null })).channels, []);
});
