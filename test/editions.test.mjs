// Catalogue-only cards, and the language editions that are made of them.
//
// A card that arrives from a set listing — tcgcsv's `tcg-<game>-<productId>`,
// or a language edition's `lng-<code>-<source>-<id>` — carries the only price
// that is really its own: the catalogue's figure for that exact product. Every
// other source on the price chain looks a card up by NAME, and a Japanese
// "ピカチュウ" or a tcgcsv Pokémon Japan "Pikachu" asked for by name comes back
// as the English card. That is the confident-wrong defect this repo keeps
// finding, and these tests are the fence around it.
//
// The Scryfall and TCGdex shapes below were read off live responses on
// 2026-09-14 and trimmed, not written to suit the code.
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EDITIONS, catalogueFigure, editionCardId, editionOf, editionSetId, indexCatalogueCards,
  indexedCard, isCatalogueOnlyCard, isEditionGame, listingPolicy, mtgEditionDetailFrom,
  mtgEditionSetsFrom, pokemonEditionDetailFrom, pokemonEditionSetsFrom, readEditionCard,
  readEditionSetId,
} from "../src/scans/editions.js";
import { categoryOf, gameOfCard, setIdOfCard } from "../src/scans/games.js";
import { gradedPricesFor } from "../src/scans/pricing.js";
import { cardTrend } from "../src/scans/market.js";
import { soldComps } from "../src/scans/thecardapi.js";
import { MarketController } from "../src/scans/market.controller.js";

/** Every network call made while `fn` runs. */
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

const JP_PIKACHU = "tcg-pokemonjp-512345";
const JP_SET = "tcg:pokemonjp:23456";

// ---- Part A: the catalogue-only price gate ------------------------------------

test("tcg- and lng- ids are catalogue-only; nothing else is", () => {
  assert.equal(isCatalogueOnlyCard(JP_PIKACHU), true);
  assert.equal(isCatalogueOnlyCard("lng-zh_tw-pk-SV5K-001"), true);
  for (const id of ["swsh7-215", "optcg-OP13-119", "mtg-abc", "sport-xyz", "", null, undefined]) {
    assert.equal(isCatalogueOnlyCard(id), false, String(id));
  }
});

test("the price route never asks anyone by name for a tcg- card, and says why it has no figure", async () => {
  const mc = new MarketController();
  const { out, calls } = await offline(() => mc.price("Pikachu", "tcg-pokemonjp-999001", "Pokémon Card 151"));
  for (const k of ["rawUsd", "byGrader", "sold", "slabPrice", "liveAsk"]) {
    assert.equal(out[k], null, `${k} must be null`);
  }
  assert.equal(out.unpriceable, "catalogue-price-only");
  assert.deepEqual(calls, [], "no store, provider or eBay call");
});

test("the only figure a tcg- card gets is the catalogue's own price for that product id", async () => {
  indexCatalogueCards({
    setId: JP_SET, name: "Pokémon Card 151",
    cards: [{ cardId: JP_PIKACHU, name: "Pikachu", localId: "025/165", imageUrl: "https://x/512345.jpg", rawUsd: 4.12, rarity: "C" }],
  }, { game: "pokemonjp" });
  const mc = new MarketController();
  const { out, calls } = await offline(() => mc.price("Pikachu", JP_PIKACHU, "Pokémon Card 151", "025/165"));
  assert.equal(out.rawUsd, 4.12);
  assert.equal(out.unpriceable, undefined);
  assert.equal(out.byGrader, null);
  assert.equal(out.slabPrice, null, "no graded figure: nothing graded is known for this product");
  assert.deepEqual(calls, []);

  const { out: graded } = await offline(() => mc.price("Pikachu", JP_PIKACHU, "Pokémon Card 151", "025/165", "PSA", "10"));
  assert.equal(graded.slabPrice, null);
  assert.equal(graded.sold, null);
});

test("gradedPricesFor answers only the indexed catalogue price for a tcg- id, before the store or a provider", async () => {
  const { out, calls } = await offline(() =>
    gradedPricesFor({ catalogId: JP_PIKACHU, name: "Pikachu", setName: "Pokémon Card 151", number: "025/165" }),
  );
  assert.deepEqual(out, { byGrader: null, byGrade: null, rawUsd: 4.12, source: "none" });
  assert.deepEqual(calls, []);
  const { out: miss } = await offline(() => gradedPricesFor({ catalogId: "lng-fr-pk-sv01-001", name: "Pikachu" }));
  assert.equal(miss.rawUsd, null);
});

test("no trend line for a catalogue-only card, even with the feed's key present", async () => {
  const saved = process.env.JUSTTCG_API_KEY;
  process.env.JUSTTCG_API_KEY = "test-key";
  try {
    const { out, calls } = await offline(() => cardTrend({ catalogId: JP_PIKACHU, name: "Pikachu" }));
    assert.equal(out, null);
    assert.deepEqual(calls, []);
  } finally {
    if (saved === undefined) delete process.env.JUSTTCG_API_KEY; else process.env.JUSTTCG_API_KEY = saved;
  }
});

test("completed sales are never fetched by name for a catalogue-only or sports card — they land in an append-only ledger", async () => {
  const saved = [process.env.THECARDAPI_KEY, process.env.THECARDAPI_DAILY_ROWS];
  process.env.THECARDAPI_KEY = "test-key";
  process.env.THECARDAPI_DAILY_ROWS = "5000";
  try {
    for (const id of [JP_PIKACHU, "lng-ja-mtg-62903b94-9020-44d9-97a2-6a0bb3c32623", "sport-YmFza2V0YmFsbHx4fHk"]) {
      const { out, calls } = await offline(() => soldComps({ catalogId: id, name: "Pikachu" }, { limit: 5 }));
      assert.deepEqual(out.sales, [], id);
      assert.deepEqual(calls, [], id);
    }
    // The control: an ordinary card with the same settings does reach the
    // provider, so the silence above is the gate and not a switched-off client.
    const { calls } = await offline(() => soldComps({ catalogId: "swsh7-215", name: "Charizard VMAX" }, { limit: 5 }));
    assert.ok(calls.length > 0, "an ordinary card is still looked up");
  } finally {
    if (saved[0] === undefined) delete process.env.THECARDAPI_KEY; else process.env.THECARDAPI_KEY = saved[0];
    if (saved[1] === undefined) delete process.env.THECARDAPI_DAILY_ROWS; else process.env.THECARDAPI_DAILY_ROWS = saved[1];
  }
});

test("the card route resolves an indexed tcg- card with no set given, and asks nobody", async () => {
  const mc = new MarketController();
  const { out, calls } = await offline(() => mc.card(JP_PIKACHU));
  assert.equal(out.name, "Pikachu");
  assert.equal(out.setName, "Pokémon Card 151");
  assert.equal(out.number, "025/165");
  assert.equal(out.game, "pokemonjp");
  assert.deepEqual(calls, []);
});

test("asks for a Japanese or Chinese edition are narrowed to that language; the summary needs a card number", () => {
  assert.deepEqual(listingPolicy(JP_PIKACHU, "025/165"), { language: "ja", blankMedian: false });
  assert.deepEqual(listingPolicy(JP_PIKACHU, null), { language: "ja", blankMedian: true });
  assert.deepEqual(listingPolicy("lng-ja-mtg-62903b94", "1"), { language: "ja", blankMedian: false });
  assert.deepEqual(listingPolicy("lng-zh_tw-pk-SV5K-001", "001"), { language: "zh", blankMedian: false });
  assert.deepEqual(listingPolicy("lng-zhs-mtg-abc", "1"), { language: "zh", blankMedian: false });
  // eBay titles cannot tell a French print from an English one, so a median
  // over them would be the English card's price.
  assert.deepEqual(listingPolicy("lng-fr-pk-sv01-001", "001"), { language: null, blankMedian: true });
  assert.deepEqual(listingPolicy("tcg-fab-711349", "MPA001"), { language: null, blankMedian: false });
  assert.deepEqual(listingPolicy("tcg-fab-711349", null), { language: null, blankMedian: true });
  assert.equal(listingPolicy("swsh7-215", "215"), null);
});

test("a figure with no catalogue price says so in the normal price shape", () => {
  const f = catalogueFigure({ name: "Pikachu", setName: null, number: null, grader: null, grade: null }, "lng-ko-pk-x-1");
  assert.equal(f.rawUsd, null);
  assert.equal(f.unpriceable, "catalogue-price-only");
  assert.deepEqual(f.listings, []);
  assert.deepEqual(f.variants, []);
});

// ---- Part B: language editions ------------------------------------------------

test("every edition has a game id, a language name and the right category", () => {
  const ids = EDITIONS.map((e) => e.id);
  assert.ok(ids.includes("lang:pokemon:zh-tw"));
  assert.ok(ids.includes("lang:mtg:ja"));
  assert.ok(!ids.includes("lang:pokemon:ja"), "Pokémon Japanese is pokemonjp, not a duplicate");
  for (const e of EDITIONS) {
    assert.ok(e.languageName && e.baseGame && e.language, e.id);
    assert.equal(isEditionGame(e.id), true);
    assert.equal(categoryOf(e.id), e.language === "ja" ? "japanese" : "language", e.id);
  }
  assert.equal(categoryOf("pokemonjp"), "japanese");
  assert.equal(categoryOf("pokemon"), "tcg");
  assert.equal(editionOf("lang:mtg:ja").languageName, "Japanese");
  assert.equal(editionOf("lang:pokemon:zh-tw").languageName, "Chinese (Traditional)");
  assert.equal(editionOf("pokemon"), null);
});

test("edition set and card ids round-trip, and a card id never needs a set to name its game", () => {
  const sid = editionSetId("lang:pokemon:zh-tw", "SV5K");
  assert.equal(sid, "lang:pokemon:zh-tw:SV5K");
  assert.deepEqual(readEditionSetId(sid), { edition: editionOf("lang:pokemon:zh-tw"), code: "SV5K" });
  assert.equal(readEditionSetId("lang:pokemon:xx:SV5K"), null);

  const cid = editionCardId(editionOf("lang:pokemon:zh-tw"), "SV5K-001");
  assert.equal(cid, "lng-zh_tw-pk-SV5K-001");
  assert.deepEqual(readEditionCard(cid), { edition: editionOf("lang:pokemon:zh-tw"), providerId: "SV5K-001" });
  const mid = editionCardId(editionOf("lang:mtg:ja"), "62903b94-9020-44d9-97a2-6a0bb3c32623");
  assert.equal(mid, "lng-ja-mtg-62903b94-9020-44d9-97a2-6a0bb3c32623");
  assert.equal(readEditionCard(mid).providerId, "62903b94-9020-44d9-97a2-6a0bb3c32623");

  assert.equal(gameOfCard(cid), "lang:pokemon:zh-tw");
  assert.equal(gameOfCard(mid), "lang:mtg:ja");
  assert.equal(gameOfCard(JP_PIKACHU), "pokemonjp");
  assert.equal(setIdOfCard(cid), null, "the set is not in the id; the caller or the index knows it");
  assert.equal(setIdOfCard(JP_PIKACHU), null);
});

test("TCGdex language sets: newest first, logos only where they exist", () => {
  const raw = [
    { id: "SC2D", name: "無極力量", cardCount: { total: 157, official: 157 } },
    { id: "SV5K", name: "狂野之力", logo: "https://assets.tcgdex.net/zh-tw/SV/SV5K/logo", cardCount: { total: 71, official: 71 } },
  ];
  const sets = pokemonEditionSetsFrom(raw, editionOf("lang:pokemon:zh-tw"));
  assert.deepEqual(sets.map((s) => s.setId), ["lang:pokemon:zh-tw:SV5K", "lang:pokemon:zh-tw:SC2D"]);
  assert.equal(sets[0].logo, "https://assets.tcgdex.net/zh-tw/SV/SV5K/logo.png");
  assert.equal(sets[1].logo, null);
  assert.equal(sets[0].total, 71);
});

test("TCGdex language set detail: printed names, pictures only where TCGdex has one, no price", () => {
  const raw = {
    id: "SV5K", name: "狂野之力", releaseDate: "2024-02-02", cardCount: { total: 71, official: 71 },
    cards: [
      { id: "SV5K-001", image: "https://assets.tcgdex.net/zh-tw/SV/SV5K/001", localId: "001", name: "毒薔薇" },
      { id: "SV5K-002", localId: "002", name: "羅絲雷朵" },
    ],
  };
  const d = pokemonEditionDetailFrom(raw, editionOf("lang:pokemon:zh-tw"));
  assert.equal(d.setId, "lang:pokemon:zh-tw:SV5K");
  assert.equal(d.releasedAt, "2024-02-02");
  assert.deepEqual(d.cards[0], {
    cardId: "lng-zh_tw-pk-SV5K-001", name: "毒薔薇", localId: "001",
    imageUrl: "https://assets.tcgdex.net/zh-tw/SV/SV5K/001/low.png", rawUsd: null, rarity: null,
  });
  assert.equal(d.cards[1].imageUrl, null);
});

test("Scryfall language sets are discovered from the cards that exist, one row per set, newest first", () => {
  const cards = [
    { set: "10e", set_name: "Tenth Edition", released_at: "2007-07-13", set_type: "core" },
    { set: "10e", set_name: "Tenth Edition", released_at: "2007-07-13", set_type: "core" },
    { set: "dsk", set_name: "Duskmourn: House of Horror", released_at: "2024-09-27", set_type: "expansion" },
  ];
  const sets = mtgEditionSetsFrom(cards, editionOf("lang:mtg:ja"));
  assert.deepEqual(sets.map((s) => s.setId), ["lang:mtg:ja:dsk", "lang:mtg:ja:10e"]);
  assert.equal(sets[0].name, "Duskmourn: House of Horror");
  assert.equal(sets[0].releasedAt, "2024-09-27");
  assert.equal(sets[0].symbol, "https://svgs.scryfall.io/sets/dsk.svg");
  assert.equal(sets[0].total, 0, "a card count for this language is not something we measured");
});

test("Scryfall language set detail: the printed name, the print's own picture, and only that print's own price", () => {
  const cards = [
    {
      id: "62903b94-9020-44d9-97a2-6a0bb3c32623", name: "Acrobatic Cheerleader", printed_name: "軽業のチアリーダー",
      lang: "ja", collector_number: "1", rarity: "common",
      image_uris: { normal: "https://cards.scryfall.io/normal/front/6/2/62903b94.jpg" },
      prices: { usd: null, eur: null },
    },
    {
      id: "dfc-1", name: "Front // Back", lang: "ja", collector_number: "2", rarity: "rare",
      card_faces: [{ printed_name: "表", image_uris: { normal: "https://cards.scryfall.io/normal/front/d/f/dfc-1.jpg" } }, { printed_name: "裏" }],
      prices: { usd: "3.50", eur: "2.00" },
    },
  ];
  const d = mtgEditionDetailFrom(cards, editionOf("lang:mtg:ja"), "dsk", { name: "Duskmourn: House of Horror", releasedAt: "2024-09-27" });
  assert.equal(d.setId, "lang:mtg:ja:dsk");
  assert.equal(d.total, 2);
  assert.deepEqual(d.cards[0], {
    cardId: "lng-ja-mtg-62903b94-9020-44d9-97a2-6a0bb3c32623", name: "軽業のチアリーダー", localId: "1",
    imageUrl: "https://cards.scryfall.io/normal/front/6/2/62903b94.jpg", rawUsd: null, rarity: "common",
  });
  assert.equal(d.cards[1].name, "表 // 裏");
  assert.equal(d.cards[1].imageUrl, "https://cards.scryfall.io/normal/front/d/f/dfc-1.jpg");
  assert.equal(d.cards[1].rawUsd, 3.5, "Scryfall's own USD figure for this exact print id");
});

test("an opened language set with no printing answers an empty set with a reason, not an error", () => {
  const d = mtgEditionDetailFrom([], editionOf("lang:mtg:ja"), "lea", { name: "Limited Edition Alpha", releasedAt: "1993-08-05" });
  assert.deepEqual(d.cards, []);
  assert.equal(d.total, 0);
  assert.match(d.note, /Japanese/);
});

test("indexing a language set lets its cards be priced and named without the set", async () => {
  const d = mtgEditionDetailFrom([{
    id: "priced-1", name: "Sheoldred", printed_name: "シェオルドレッド", lang: "ja", collector_number: "107",
    rarity: "mythic", image_uris: { normal: "https://x/s.jpg" }, prices: { usd: "80.00" },
  }], editionOf("lang:mtg:ja"), "dmu", { name: "Dominaria United", releasedAt: "2022-09-09" });
  indexCatalogueCards(d, { game: "lang:mtg:ja" });
  const id = "lng-ja-mtg-priced-1";
  assert.equal(indexedCard(id).rawUsd, 80);
  const mc = new MarketController();
  const { out, calls } = await offline(() => mc.price("シェオルドレッド", id, "Dominaria United", "107"));
  assert.equal(out.rawUsd, 80);
  assert.deepEqual(calls, []);
  const { out: card } = await offline(() => mc.card(id));
  assert.equal(card.name, "シェオルドレッド");
  assert.equal(card.game, "lang:mtg:ja");
});
