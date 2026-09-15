// Sports, read off eBay's item specifics — and the price that must never come
// with it.
//
// A sports entry is a PLAYER WITHIN A SET. On 2026-09-14 one page of Victor
// Wembanyama 2023-24 Panini Prizm listings ran from a US$43 Deep Space Silver
// Prizm to a US$800 PSA 10 #136, with two "1/1 Alien Green Prizm" asks at
// US$500 between them. Every one of those is this entry. Any single figure
// printed under it is one card's price presented as all of them — the defect
// class this repo keeps finding, wearing a sports jersey.
//
// The distributions and titles below are trimmed from the live responses of
// that day, not written to suit the code.
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SPORTS, isJunkValue, keepSet, noFigure, pairHits, pickArt, sportArt, sportShare, playerMatch, playersFromDistribution,
  readSportCard, readSportSetId, setsFromDistribution, sportCardId, sportCardMeta,
  sportSetId, titleNamesSet, yearOf,
} from "../src/scans/sports.js";
import { categoryOf, gameOfCard, setIdOfCard } from "../src/scans/games.js";
import { gradedPricesFor } from "../src/scans/pricing.js";
import { cardTrend } from "../src/scans/market.js";
import { MarketController } from "../src/scans/market.controller.js";

const WEMBY = sportCardId("basketball", "2023-24 Panini Prizm", "Victor Wembanyama");

/** Every network call made while `fn` runs. A sports price must make none. */
async function offline(fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("no network in this test");
  };
  try {
    return { out: await fn(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

// ---- the price rule ---------------------------------------------------------

test("the price route answers every figure null for a sports card, and asks nobody", async () => {
  const mc = new MarketController();
  const { out, calls } = await offline(() =>
    mc.price("Victor Wembanyama", WEMBY, "2023-24 Panini Prizm"),
  );
  for (const k of ["rawUsd", "byGrader", "sold", "slabPrice", "liveAsk"]) {
    assert.equal(out[k], null, `${k} must be null`);
  }
  assert.deepEqual(out.listings, []);
  assert.deepEqual(out.shops, []);
  assert.equal(out.unpriceable, "player-in-set");
  assert.deepEqual(calls, [], "no store, provider or eBay call for a sports price");
});

test("the refusal holds when the page sends only the game, or a grade", async () => {
  const mc = new MarketController();
  const { out, calls } = await offline(() =>
    mc.price("Victor Wembanyama", undefined, "2023-24 Panini Prizm", undefined, "PSA", "10",
      undefined, undefined, "sport:basketball"),
  );
  assert.equal(out.slabPrice, null);
  assert.equal(out.sold, null);
  assert.equal(out.grade, 10);
  assert.deepEqual(calls, []);
});

test("gradedPricesFor refuses a sports id before the store or the provider", async () => {
  const { out, calls } = await offline(() =>
    gradedPricesFor({ catalogId: WEMBY, name: "Victor Wembanyama", setName: "2023-24 Panini Prizm" }),
  );
  assert.deepEqual(out, { byGrader: null, byGrade: null, rawUsd: null, source: "none" });
  assert.deepEqual(calls, []);
});

test("no trend line for a sports card, even with the feed's key present", async () => {
  const saved = process.env.JUSTTCG_API_KEY;
  process.env.JUSTTCG_API_KEY = "fixture";
  try {
    const { out, calls } = await offline(() =>
      cardTrend({ catalogId: WEMBY, name: "Victor Wembanyama", game: "sport:basketball" }),
    );
    assert.equal(out, null);
    assert.deepEqual(calls, []);
  } finally {
    if (saved === undefined) delete process.env.JUSTTCG_API_KEY;
    else process.env.JUSTTCG_API_KEY = saved;
  }
});

test("noFigure keeps the normal price shape, so the page renders 'no price' rather than breaking", () => {
  const out = noFigure({ name: "Wayne Carey", setName: "1995 Select" });
  for (const k of ["rawUsd", "variants", "byGrader", "sold", "slabPrice", "liveAsk", "listings", "shops"]) {
    assert.ok(k in out, k);
  }
});

// ---- ids ----------------------------------------------------------------------

test("a card id carries its whole identity and survives commas, accents and bars", () => {
  for (const [slug, set, player] of [
    ["afl", "1995 Select", "Gary Ablett, Sr."],
    ["basketball", "2018-19 Panini Prizm", "Luka Dončić"],
    ["baseball", "2024 Topps Chrome | Update", "Ronald Acuña Jr."],
  ]) {
    const id = sportCardId(slug, set, player);
    assert.match(id, /^sport-[A-Za-z0-9_-]+$/);
    const read = readSportCard(id);
    assert.equal(read.sport.slug, slug);
    assert.equal(read.set, set);
    assert.equal(read.player, player);
  }
  assert.equal(readSportCard("sport-bm90IGEgY2FyZA"), null);   // "not a card"
});

test("the card resolves to its sport and set without a stored row", () => {
  assert.equal(gameOfCard(WEMBY), "sport:basketball");
  assert.equal(setIdOfCard(WEMBY), "sport:basketball:2023-24%20Panini%20Prizm");
  const meta = sportCardMeta(WEMBY);
  assert.equal(meta.name, "Victor Wembanyama");
  assert.equal(meta.setName, "2023-24 Panini Prizm");
  assert.equal(meta.number, null);
  assert.equal(meta.game, "sport:basketball");
  assert.deepEqual(readSportSetId(sportSetId("nrl", "2008 Select NRL Champions")).set, "2008 Select NRL Champions");
});

test("sports land in Sports, including a bought category named for one", () => {
  assert.equal(categoryOf("sport:afl"), "sports");
  assert.equal(categoryOf("ch:Baseball"), "sports");
  assert.equal(categoryOf("ch:Pokemon"), "tcg");
  assert.equal(categoryOf("pokemon"), "tcg");
});

// ---- reading the distributions --------------------------------------------------

const d = (pairs) => pairs.map(([v, n]) => ({ localizedAspectValue: v, matchCount: n }));

test("AFL sets: the mis-tagged American sets below the floor go, the Select releases stay", () => {
  // EBAY_AU, Sport: Australian Rules Football, League: AFL.
  const sets = setsFromDistribution("afl", d([
    ["Not specified", 241179], ["2010 Topps", 10], ["2009 SP", 12], ["1995 Best", 8],
    ["1995-96 Select", 5], ["1995 Select", 2523], ["1996 Select", 2206], ["1994 Select", 1001],
    ["2002 Select Australia Exclusive AFL", 197],
  ]));
  const names = sets.map((s) => s.name);
  assert.ok(!names.includes("Not specified"));
  for (const junk of ["2010 Topps", "2009 SP", "1995 Best", "1995-96 Select"]) {
    assert.ok(!names.includes(junk), junk);
  }
  assert.deepEqual(names, ["2002 Select Australia Exclusive AFL", "1996 Select", "1995 Select", "1994 Select"]);
  for (const s of sets) {
    assert.equal(s.total, 0, "a listing count is not a card count");
    assert.equal(s.releasedAt, `${yearOf(s.name)}-01-01`);
  }
});

test("junk values are a seller declining to answer", () => {
  for (const v of ["Not Specified", "Not specified", "2023", "#1", "MVP", ""]) assert.ok(isJunkValue(v), v);
  for (const v of ["1952 Topps", "Victor Wembanyama", "Bayley"]) assert.ok(!isJunkValue(v), v);
});

test("players: two sellers must agree, unless the league filter already cleaned the set", () => {
  const dist = d([["Alex Jesaulenko", 8], ["Bruce Doull", 1], ["Not specified", 900]]);
  assert.deepEqual(playersFromDistribution(dist).map((p) => p.name), ["Alex Jesaulenko"]);
  assert.deepEqual(playersFromDistribution(dist, 1).map((p) => p.name), ["Alex Jesaulenko", "Bruce Doull"]);
});

test("a title names a set by its season's first year, never by the brand alone", () => {
  const set = "2023-24 Panini Prizm";
  assert.ok(titleNamesSet("2023-24 Panini Prizm Deep Space Victor Wembanyama #1 Silver Prizm RC", set));
  assert.ok(titleNamesSet("Graded 2023 Panini Prizm Victor Wembanyama #136 Rookie RC Card PSA 10", set));
  assert.ok(!titleNamesSet("Panini Prizm Victor Wembanyama Rookie", set));
  assert.ok(!titleNamesSet("2022-23 Panini Prizm Draft Picks Wembanyama", set));
});

// ---- search -------------------------------------------------------------------

test("a different player is not a hit", () => {
  assert.ok(playerMatch("wembanyama", "Victor Wembanyama") > 0);
  assert.ok(playerMatch("jordan", "Michael Jordan") > 0);
  assert.ok(playerMatch("jordan", "Jordan Love") > 0, "both are Jordans");
  assert.equal(playerMatch("michael jordan", "Jordan Love"), 0);
  assert.equal(playerMatch("wemby", "Victor Wembanyama"), 0);
  assert.ok(playerMatch("Luka Doncic", "Luka Dončić") > 0, "accents fold");
});

test("a query spanning sports never labels a player with somebody else's sport", () => {
  // "jordan" on 2026-09-14: basketball overall, but Jordan Walker is baseball
  // and came back as a basketball player in 2023 Topps Chrome before this.
  const body = {
    refinement: {
      aspectDistributions: [
        { localizedAspectName: "Sport", aspectValueDistributions: d([["Basketball", 60000], ["Baseball", 9000], ["Football", 7000]]) },
        { localizedAspectName: "Player/Athlete", aspectValueDistributions: d([["Michael Jordan", 52000], ["Jordan Walker", 4000], ["Jordan Love", 3500]]) },
        { localizedAspectName: "Set", aspectValueDistributions: d([["1986 Fleer", 3000], ["2023 Topps Chrome", 2500], ["1990-91 NBA Hoops", 2800]]) },
      ],
    },
    itemSummaries: [
      { title: "2023 Topps Chrome Jordan Walker RC #25 Refractor", image: { imageUrl: "https://i.ebayimg.com/w.jpg" } },
      { title: "1986 Fleer Michael Jordan #57 Rookie PSA 8", image: { imageUrl: "https://i.ebayimg.com/mj.jpg" } },
    ],
  };
  const hits = pairHits("jordan", body);
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.name === "Michael Jordan"), hits.map((h) => h.name).join(", "));
  assert.ok(!hits.some((h) => h.setName === "2023 Topps Chrome"), "the query's set list is not his");
  assert.equal(hits[0].setName, "1986 Fleer");
  assert.equal(hits[0].game, "sport:basketball");
});

test("one player, one sport: his sets are offered, with a picture where a title proves it", () => {
  const body = {
    refinement: {
      aspectDistributions: [
        { localizedAspectName: "Sport", aspectValueDistributions: d([["Basketball", 12000]]) },
        { localizedAspectName: "Player/Athlete", aspectValueDistributions: d([["Victor Wembanyama", 12218]]) },
        { localizedAspectName: "Set", aspectValueDistributions: d([["2023-24 Panini Prizm", 4590], ["2023-24 Panini Instant", 900]]) },
      ],
    },
    itemSummaries: [
      { title: "2023-24 Panini Prizm Deep Space Victor Wembanyama #1 Silver Prizm RC", image: { imageUrl: "https://i.ebayimg.com/g/MugAAeSwTbZqp4Fq/s-l225.jpg" } },
    ],
  };
  const hits = pairHits("wembanyama", body);
  assert.equal(hits[0].cardId, WEMBY);
  assert.equal(hits[0].imageUrl, "https://i.ebayimg.com/g/MugAAeSwTbZqp4Fq/s-l225.jpg");
  assert.equal(hits[0].localId, "");
  assert.deepEqual(hits.map((h) => h.setName), ["2023-24 Panini Prizm", "2023-24 Panini Instant"]);
});

// ---- pictures, one player at a time ----------------------------------------------
//
// A set's own call pictured about one card in fifteen, and none of the five
// players in a small set. The per-player lookup fixes that, and its cache has
// two kinds of null that must not be confused: "eBay has no picture of him"
// (asked, keep it a day) and "we did not ask" (budget refused, or the call
// failed — keep nothing, or one bad minute blanks a card for a day).

/** eBay, played by a stub: a token, then whatever `browse` returns. */
async function withEbay(browse, fn) {
  const real = globalThis.fetch;
  const saved = { ...process.env };
  process.env.EBAY_APP_ID = process.env.EBAY_APP_ID || "fixture";
  process.env.EBAY_CERT_ID = process.env.EBAY_CERT_ID || "fixture";
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/oauth2/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 7200 }) };
    }
    calls.push(u);
    return browse(u);
  };
  try {
    return { out: await fn(), calls };
  } finally {
    globalThis.fetch = real;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const heldBody = (player, items) => ({
  ok: true, status: 200,
  json: async () => ({
    refinement: {
      aspectDistributions: [
        { localizedAspectName: "Sport", aspectValueDistributions: d([["Soccer", 0]]) },
        { localizedAspectName: "Set", aspectValueDistributions: d([["2009 Topps", 0]]) },
        { localizedAspectName: "Player/Athlete", aspectValueDistributions: d([[player, 0]]) },
      ],
    },
    itemSummaries: items,
  }),
});

test("a genuine miss is cached: eBay is not asked twice about a player with no picture", async () => {
  const id = sportCardId("soccer", "2009 Topps", "Fixture Nopicture");
  const first = await withEbay(() => heldBody("Fixture Nopicture", []), () => sportArt([id]));
  assert.deepEqual(first.out, { [id]: null });
  assert.equal(first.calls.length, 1);
  const second = await withEbay(
    () => heldBody("Fixture Nopicture", [{ title: "Nopicture", image: { imageUrl: "https://i.ebayimg.com/late.jpg" } }]),
    () => sportArt([id]),
  );
  assert.deepEqual(second.out, { [id]: null }, "the recorded miss stands for the day");
  assert.equal(second.calls.length, 0);
});

test("a budget refusal is not cached: the next request asks", async () => {
  const id = sportCardId("soccer", "2009 Topps", "Fixture Refused");
  const refused = await withEbay(() => { throw new Error("must not be called"); }, async () => {
    process.env.EBAY_CATALOGUE_DAILY_MAX = "0";
    return sportArt([id]);
  });
  assert.deepEqual(refused.out, { [id]: null });
  assert.equal(refused.calls.length, 0);
  const later = await withEbay(
    () => heldBody("Fixture Refused", [{ title: "2009 Topps Fixture Refused #12", image: { imageUrl: "https://i.ebayimg.com/r.jpg" } }]),
    () => sportArt([id]),
  );
  assert.deepEqual(later.out, { [id]: "https://i.ebayimg.com/r.jpg" });
});

test("a failed call is not cached either", async () => {
  const id = sportCardId("soccer", "2009 Topps", "Fixture Failed");
  const failed = await withEbay(() => ({ ok: false, status: 500, json: async () => ({}) }), () => sportArt([id]));
  assert.deepEqual(failed.out, { [id]: null });
  const later = await withEbay(
    () => heldBody("Fixture Failed", [{ title: "x", image: { imageUrl: "https://i.ebayimg.com/f.jpg" } }]),
    () => sportArt([id]),
  );
  assert.equal(later.out[id], "https://i.ebayimg.com/f.jpg");
});

test("a dropped player filter is somebody else's listings, so it is a miss, not a face", async () => {
  const id = sportCardId("soccer", "2009 Topps", "Fixture Dropped");
  const r = await withEbay(() => ({
    ok: true, status: 200,
    json: async () => ({
      refinement: { aspectDistributions: [
        { localizedAspectName: "Player/Athlete", aspectValueDistributions: d([["Lionel Messi", 900], ["Cristiano Ronaldo", 800]]) },
      ] },
      itemSummaries: [{ title: "Messi", image: { imageUrl: "https://i.ebayimg.com/messi.jpg" } }],
    }),
  }), () => sportArt([id]));
  assert.equal(r.out[id], null);
});

test("twelve ids at most, duplicates once, non-sports ids ignored", async () => {
  const ids = Array.from({ length: 15 }, (_, i) => sportCardId("soccer", "2009 Topps", `Fixture Many ${i}`));
  const r = await withEbay(
    (u) => heldBody("x", [{ title: "t", image: { imageUrl: "https://i.ebayimg.com/m.jpg" } }]),
    () => sportArt([ids[0], ids[0], "base1-4", ...ids]),
  );
  assert.equal(Object.keys(r.out).length, 12);
  assert.ok(!("base1-4" in r.out));
  assert.equal(r.calls.length, 12);
});

test("the picture prefers a title with the surname, and takes any picture after that", () => {
  const items = [
    { title: "2009 Topps Premier League Manchester United #12", image: { imageUrl: "https://i.ebayimg.com/one.jpg" } },
    { title: "2009 Topps Wayne Rooney #12", image: { imageUrl: "https://i.ebayimg.com/rooney.jpg" } },
  ];
  assert.equal(pickArt(items, "Wayne Rooney"), "https://i.ebayimg.com/rooney.jpg");
  assert.equal(pickArt(items.slice(0, 1), "Wayne Rooney"), "https://i.ebayimg.com/one.jpg");
  assert.equal(pickArt([{ title: "no image" }], "Wayne Rooney"), null);
});

test("a pick-your-card listing is a pile of cards, not a picture of the player", () => {
  // The listing all three 2009 Topps soccer players shared on 2026-09-14.
  const pile = [
    { title: "A7671- 2009-10 Topps Match Attax English Premier G2 -You Pick- 15+ FREE US SHIP", image: { imageUrl: "https://i.ebayimg.com/images/g/mLIAAOSwWHpgv-dD/s-l225.jpg" } },
    { title: "Match atttax cards 2009/2010 ( 2 - 100 Club ) + whole collection and managers", image: { imageUrl: "https://i.ebayimg.com/pile2.jpg" } },
  ];
  for (const p of ["Jermain Defoe", "John Terry", "Shay Given"]) assert.equal(pickArt(pile, p), null, p);
  // ...unless the title names him, which is the seller pointing at his card.
  assert.equal(
    pickArt([{ ...pile[0], title: "2009-10 Topps Match Attax John Terry #12 -You Pick-" }], "John Terry"),
    "https://i.ebayimg.com/images/g/mLIAAOSwWHpgv-dD/s-l225.jpg",
  );
});

// ---- mis-tagged sets --------------------------------------------------------------

const AFL = SPORTS.find((s) => s.slug === "afl");

test("AFL: the baseball sets tagged AFL go, every Select, Teamcoach and Scanlens set stays", () => {
  // Shares measured on eBay AU, 2026-09-14 (see sports.ts).
  const measured = {
    "2009 Topps": 0.006, "2008 Topps": 0.003, "2007 Topps": 0.0002, "2002 SPx": 0.069,
    "1888 Allen & Ginter The World's Racers": 0.070, "1996 Select Certified Edition": 0.024,
    "1994 Classic": 0.024, "1996 Classic": 0.026,
    "1998 Select": 0.551, "1997 Select": 0.096, "1996 Select": 0.261, "1995 Select": 0.235,
    "1994 Select": 0.146, "2002 Select Australia Exclusive AFL": 1.0,
    "2012 Teamcoach": 0.06, "1990 Scanlens": 0.08,
  };
  const kept = Object.entries(measured).filter(([n, sh]) => keepSet(AFL, n, sh)).map(([n]) => n);
  for (const gone of ["2009 Topps", "2008 Topps", "2007 Topps", "2002 SPx", "1888 Allen & Ginter The World's Racers", "1996 Select Certified Edition", "1994 Classic"]) {
    assert.ok(!kept.includes(gone), gone);
  }
  for (const stays of ["1998 Select", "1997 Select", "1996 Select", "1995 Select", "1994 Select", "2002 Select Australia Exclusive AFL", "2012 Teamcoach", "1990 Scanlens"]) {
    assert.ok(kept.includes(stays), stays);
  }
});

test("a set that names the league is kept without measuring; an unmeasured stranger is not", () => {
  assert.equal(keepSet(AFL, "2022 Select AFL Footy Stars", null), true);
  assert.equal(keepSet(AFL, "1995 Select", null), true, "a local printer survives a failed measurement");
  assert.equal(keepSet(AFL, "2009 Topps", null), false);
  const basketball = SPORTS.find((s) => s.slug === "basketball");
  assert.equal(keepSet(basketball, "2009 Topps", 0.001), true, "the rule is for the small sports only");
});

test("share ignores sellers who named no sport", () => {
  const dist = d([["Not specified", 90000], ["Baseball", 750], ["Australian Rules Football", 250]]);
  assert.equal(sportShare(dist, "Australian Rules Football"), 0.25);
});
