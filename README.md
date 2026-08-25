# grail-market-backend

Identifies a trading card from a photograph, reads the grading label if it is in
a slab, and prices it.

Two services, one repo, because they only ever run together:

- **api** (`src/`) — NestJS. Identification chain, valuation chain, price caching,
  eBay compliance endpoint. This is what the web and mobile clients talk to.
- **vision** (`vision/`) — Python/FastAPI. OpenCV card detection, centering
  measurement, RapidOCR text and slab-label reading. Only the api calls it.

## Running it

```bash
npm install
npm run vision:install          # one-time: python deps into a local venv

cp .env.example .env            # then fill in the keys you have

npm run dev:vision              # vision on :8100
npm run dev                     # api on :8180  (needs vision up)
```

The api will start without vision, but every scan will fail — it has nothing to
read the card with.

## Tests

```bash
npm run test         # api fixtures
npm run test:vision  # vision fixtures
npm run test:all
```

Fixtures come from cards that were priced wrongly. Each one pins the specific
misreading that caused it, so the same mistake cannot come back quietly.

## Layout

```
src/            api — NestJS
  scans/        identification and valuation. The interesting code is here.
vision/         python service
packages/shared zod schemas shared between the two halves of the api
docs/           architecture, and the grading domain primer
research/       decks, accuracy reports, and the sample cards behind them
scripts/        venv resolver, so the python commands work on any platform
```

`CLAUDE.md` holds the domain invariants — read it before touching pricing. The
short version: a grade belongs to (card + grading company), never to a card
alone, and a card number is not a product.
