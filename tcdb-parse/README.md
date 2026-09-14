# tcdb-parse

TCDB (Trading Card Database) reached through [Parse](https://parse.bot),
which turns a website into a typed API.

## Why this exists

`src/scans/games.ts` says it plainly: sports has no free catalogue anywhere,
every reference database for it is commercial, and that is why a marketplace
promising TCGs "alongside sports cards" cannot list a single sports card.
Card Hedge was bought to cover that gap. TCDB is the free alternative.

## Status: NOT WORKING YET

Stopped at step 2 of the setup. What is done:

- `uv` installed (0.12.13), project initialised here.
- `requires-python` raised to >=3.10, which `parse-sdk` needs.

What is blocked:

- `uv add parse-sdk` is refused by the sandbox permission classifier, so the
  SDK is not installed and `parse login` / `parse init` / `parse add` have
  not run.
- The plain-HTTP route needs a `scraper_id`, and that is NOT the marketplace
  slug — `POST /scraper/tcdb-com-api/list_sets` returns
  `{"error":"Scraper with ID tcdb-com-api not found"}`. The only documented
  way to get it is `uv run parse list --json`, which needs the SDK.

So no real call has succeeded yet, and nothing here should be trusted until
one has.

## Finishing it

    export PARSE_API_KEY=pmx_...          # never commit this
    uv add parse-sdk
    uv run parse login --api-key "$PARSE_API_KEY"
    uv run parse init
    uv run parse add --marketplace tcdb-com-api
    cat parse_apis/*/README.md            # the exact import line lives here
    uv run parse list --json              # this is where the scraper_id is

`list_sets` takes a year and a sport, optionally a name filter, and returns
set summaries with ids for `get_set_details` and `get_checklist`. It is not
paginated — one year of one sport comes back whole.

## Where it should end up

Not here. The catalogue is consumed by NestJS, and a Python sidecar would
need its own process and its own route to Postgres. Once the `scraper_id` is
known, the adapter belongs beside `src/scans/opensources.ts` as one more
free catalogue — cached for a day like the four already there, with sets
prefixed so a TCDB set id can never collide with one of theirs.

This project stays as the scratch space for reading response shapes before
that adapter is written, which is how every other source in `opensources.ts`
was built: called first, then written.
