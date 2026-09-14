# Project rules

## Domain invariants — never violate these

1. A grade is a property of (card + grading company), never of the card alone.
   Price keys are always (catalog_id, grader, grade, qualifier, label_variant).
   There is no grade-only price lookup anywhere in this system.

2. Never convert a grade between graders to fetch a price. BGS 9.5 is not
   PSA 10. CGC has two different 10s. SGC legacy slabs use a 100-point scale.
   Cross-grader ratios may only be used as an explicitly labelled LOW-confidence
   fallback, and must be measured from our own sales data, never hand-written.

3. BCCG is a discount tier, not Beckett's main line. A BCCG 10 is worth a
   fraction of a BGS 10. BRCR / Raw Card Review is not a slab - price it as raw.

4. A grade token in text does not mean the card is graded. Check the negative
   guards (CANDIDATE, WOULD GRADE, UNGRADED, trailing "?", adjacent #/fraction,
   lot markers) before treating it as a slab.

5. sales_ledger is append-only. Never UPDATE, never DELETE. Always store
   raw_title and parser_version so history can be reparsed when the parser
   improves.

6. Sold price is not a listing price. Listing guidance returns a three-point
   range (quick sale / market / patient ask) with the last sale date attached.

## Engineering rules

- Every price response carries confidence and sample_size.
- A missing answer is cheap; a confident wrong answer is expensive. Return
  "unknown" with a reason rather than guessing.
- All external price sources sit behind an adapter interface.
- Fixtures before fixes. Every bug gets a failing test first.
- Log every result below MEDIUM confidence with its inputs. That log is the
  backlog. It is `low_confidence_log`, written by `recordWeakResult()`, and
  what goes in it is decided by `classifyWeakness()` in `scans.service.ts`.

## Do not

- Do not use PriceCharting's API for graded prices (collapses graders below 10).
- Do not scrape eBay directly (login wall since 22 July 2026; use the adapter).
- Do not swap the OCR engine to fix accuracy - fix the crops, not the engine.
- Do not add a paid dependency without asking. If you add one, it needs a
  daily cap and a cache before it ships, not after — see `CARDGRADER_DAILY_MAX`
  for the shape. A paid call with no ceiling is an unbounded bill.
- Do not call a price provider from a request handler. Go through
  `gradedPricesFor()`, or the store stops being the source of truth and the
  cost model goes back to scaling with traffic.
- Do not add an in-process cache as a bare `Map`. Use `TtlCache` — the Maps it
  replaced were never evicting anything and grew until the process died.

## Reference documents

- `docs/solution-architecture.md` — target architecture, stage contracts, data
  model, roadmap. Re-read the relevant section before changing a stage.
- `docs/grading-knowledge-base.md` — domain primer: grader scales, label
  variants, the failure catalogue used to build fixtures.

## Repository layout

This repo is api + vision. The web and mobile clients live in their own repos.

- `vision/` — Python/FastAPI. OpenCV detection, RapidOCR text and slab-label
  reading. Runs on our own infrastructure. It does NOT grade — see below.
- `src/` — NestJS. Identification chain, valuation chain, eBay compliance
  endpoint.
- `src/ingest/` — the batch price refresh. `npm run ingest`.
- `packages/shared` — zod schemas shared with the clients.

## Pricing architecture — read this before touching a price path

Prices are READ from our own store and REFRESHED on a schedule. They are not
bought on the request path.

- `gradedPricesFor()` in `src/scans/pricing.ts` is the only way to get a graded
  price. Store first, provider only on a miss. Both the scan path and the
  search path call it, because a scan and a search that land on the same card
  must not quote two figures for it.
- `npm run ingest` refreshes the store, tiered by liquidity and demand: hot
  cards daily, warm weekly, the tail monthly. It reserves a quarter of the
  provider's daily credits for live scans.
- `catalog_cards` is the work list. Every identification registers a card, for
  every game — including the ones we cannot price yet.
- Adding a column to `SCHEMA` in `cards.store.ts` does NOT alter an existing
  table. Add an entry to `MIGRATIONS` beside it. Append, never edit.
- Provider keys live ENCRYPTED in `provider_keys` (AES-256-GCM, master secret
  in `PPT_KEY_SECRET`). Manage them with `npm run keys`. `pickKey()` is on the
  scan path and stays synchronous, so it reads an in-memory snapshot refreshed
  at boot and on an interval — anything that runs outside the server must
  `await reloadKeys()` first or it sees an empty pool.
- `PPT_API_KEY` may hold several comma-separated keys, added to that pool as a
  fallback. Each carries its own
  quota and its own breaker in `pptkeys.ts`, addressed by a digest of the key
  rather than its position, so reordering the list does not reassign state. A
  429 for credit exhaustion locks ONE key and moves to the next. Never put the
  key material in a log line — use the 8-char id.
- The page size IS the price of a lookup: the provider bills per card returned.
  The scan path needs 3 candidates because it searches by fuzzy text; the
  refresh job knows the exact identity and asks for 1. Do not raise
  `PPT_INGEST_PAGE_SIZE` without a card it is actually missing.

The reason: buying on the request path makes the bill scale with traffic. A
price is a property of the catalogue, which is roughly fixed, so the refresh
job makes a hundred scans a day and a million cost the same.

## We do not grade cards

The vision service returns `grade: null` on every path, deliberately. For a
slab it was second-guessing a professional; for a raw card the heuristics
turned an $84 card into $21. Reading the grade a company already ASSIGNED, off
the slab label, is not grading and is core to the product — keep `slab.py`.

`compute_grade` and `measure_centering` are parked, not deleted: still in the
tree, still tested, called from nowhere. If you wire either back in, know that
you are also re-enabling every paid grading dependency that guards on a
non-null grade.

## The Card API — completed sales

`src/scans/thecardapi.ts`. Itemised SOLD rows, which no other source here
sells: PPT returns per-grade rollups, JustTCG a trend line, and eBay's
Marketplace Insights was never approved. `sales_ledger` was built on the
assumption this was unbuyable; it now fills from the market as well as from
our own trades, via the `ingest-sold-feed` maintenance job.

Off unless `THECARDAPI_KEY` and `THECARDAPI_DAILY_ROWS` are both set.

- **The budget is ROWS, not calls.** The only provider here that is metered
  that way. One request may return 1,000 rows and the plan grants a fixed
  number per UTC day, so a cap counted in requests means nothing. The job may
  spend half; the rest is held for scans.
- **eBay rows are a raw title and nothing else.** `category`, `sport`,
  `player`, `grader`, `card_set` and `card_number` are null on every one —
  measured, not read off the docs. Any filter on a structured field silently
  drops the whole eBay half, which is 99% of the volume and all of the sports.
  `category=sports` returns zero rows while the feed is full of hockey.
- **The query is the highest-leverage line in the file.** `q=<name>` sorted
  date_desc returns whatever released this week; on 2026-09-11 a bare
  `Charizard` kept 0 of 25 rows. `q=<name> "<set>"` kept 9 of 25, all real.
- **The query syntax, measured 2026-09-14.** An earlier note here said they had
  no boolean syntax. That was wrong — it was written after testing only the
  two forms that fail.
  - Space = AND. `xyzzy select` returns 0.
  - `"..."` = phrase. `"gold parallel"` 167 vs unquoted `gold parallel` 274.
  - `(a,b)` = OR, and it is a true union rather than a sum:
    `(charizard,pikachu) pokemon` is 5,500 against 2,447 + 3,102 = 5,549,
    the 49 difference being listings holding both terms.
  - The literal word `AND` is a SEARCH TERM, not an operator — it collapses
    117 rows to 1. `+term` returns nothing. A comma outside parentheses is
    literal too: `afl,nrl select` is 0 where `(afl,nrl) select` is 195.
- **Every row goes through the asks-panel guards** (`mentionsCard`,
  `sameForm`, `setInTitle`, `numberInTitle`) plus `setEditionMismatch`, which
  is new and separates "Base Set" from "Base Set 2". A sold row is worse than
  an ask row when it is wrong: an ask is a claim, a sale is evidence, and the
  evidence lands in an append-only ledger.
- `saleGrade()` is where invariant 4 finally lives in code. A grade token in a
  title is not a grade — "PSA 10 CANDIDATE", "would grade PSA 9", a trailing
  "?" and `#PSA 10` are all raw cards.
- `recordSale()` now takes an optional deterministic `saleId` and the insert
  is `on conflict do nothing`. Provider rows reappear on every pull whose
  window still covers them; without this, sample sizes would grow daily on no
  new evidence. Still never UPDATEs and never DELETEs.
- `/coverage` hangs — two consecutive 60s timeouts on 2026-09-11 against
  `/platforms` returning the identical payload in 1.3s. `coverage()` reads
  `/platforms`.
- On a short lookback plan, five of their seven platforms are invisible:
  Goldin, REA, SCP, Hakes and Lelands all have newest sales months old, so a
  3-day window ends before their data begins. Only eBay and TCGplayer are live.
- Rows carry mixed currencies (USD, AUD, GBP seen in one result set). The
  ledger stores `currency` per row; anything aggregating them must convert.
- **Australian sports is covered, and it is all AUD.** AFL and NRL both return
  real recent sales — `(afl,nrl) select` 195, `"footy stars"` 50, `nrl traders`
  8 — and across 108 rows sampled every one was eBay and every one was AUD, so
  the home market needs no conversion. They are all unenriched like the rest of
  the eBay half: no grader, no sport, no player, no category. 38 of those 108
  were `best_offer`, which is the accepted-offer price eBay's own API will not
  give us.

## Parse (parse.bot)

Not yet wired. Intended for tcdb.com — the free sports/non-sport catalogue
that `games.ts` says does not exist anywhere, which is the one gap Card Hedge
was bought to cover.

Parse exposes both a Python SDK (`uv add parse-sdk`, clients generated under
`parse_apis/`) and plain HTTP:

    POST https://api.parse.bot/scraper/{scraper_id}/{endpoint_name}
    X-API-Key: $PARSE_API_KEY
    {"year": 1986, "sport": "Baseball"}

For this repo the HTTP form is the one to use — the catalogue is consumed by
NestJS, and a Python sidecar would need its own process to reach Postgres.
The adapter belongs beside `opensources.ts` and must be cached for a day like
every other catalogue there. The key is read from `PARSE_API_KEY`, never
committed.

Blocked on the `scraper_id`: it is not the marketplace slug (`tcdb-com-api`
404s) and the only lookup is `uv run parse list --json`, which needs the SDK
installed.
