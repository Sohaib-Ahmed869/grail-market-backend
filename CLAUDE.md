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
