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
  backlog.

## Do not

- Do not use PriceCharting's API for graded prices (collapses graders below 10).
- Do not scrape eBay directly (login wall since 22 July 2026; use the adapter).
- Do not swap the OCR engine to fix accuracy - fix the crops, not the engine.
- Do not add a paid dependency without asking.

## Reference documents

- `docs/solution-architecture.md` — target architecture, stage contracts, data
  model, roadmap. Re-read the relevant section before changing a stage.
- `docs/grading-knowledge-base.md` — domain primer: grader scales, label
  variants, the failure catalogue used to build fixtures.

## Repository layout

- `services/vision` — Python/FastAPI. OpenCV detection, centering measurement,
  RapidOCR text and slab-label reading. Runs on our own infrastructure.
- `apps/api` — NestJS. Identification chain, valuation chain, price caching
  (SQLite local + Neon Postgres shared), eBay compliance endpoint.
- `apps/web` — Next.js. Scan UI, price hero, currency conversion.
- `packages/shared` — zod schemas shared between api and web.
