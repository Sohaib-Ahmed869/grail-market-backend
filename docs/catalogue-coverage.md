# Catalogue & Price Coverage

What GrailMarket can list, what it can price, and what it cannot do at all.
Every figure was read from the running API or from the provider on the date
shown — none is from memory.

**Measured 8 September 2026.**

---

## 1. What we can show today — 2,285 sets, no signup

| Game | Sets | Source | Cost |
|---|---:|---|---|
| Yu-Gi-Oh! | 1,035 | ygoprodeck | free |
| Magic: The Gathering | 988 | Scryfall | free |
| Pokémon | 218 | TCGdex | free |
| One Piece | 22 | optcgapi | free |
| Lorcana | 22 | lorcast | free |
| **Total** | **2,285** | | **$0** |

Magic was 144 until 8 Sep. Our own filter kept only `core` and `expansion`
sets, discarding 298 promo sets, all 45 Commander decks, 32 Masters sets and
every one of the 19 Masterpiece sets — Zendikar Expeditions and Kaladesh
Inventions among them. The filter is now "does the card physically exist",
which is the only question a marketplace should ask.

## 2. Free and not yet wired — four to nine games

| Source | Adds | Status |
|---|---|---|
| apitcg.com | Dragon Ball, Union Arena, Gundam, Riftbound | **key already owned**, wired for scanning only |
| swu-db.com | Star Wars Unlimited (39 sets) | responds, not wired |
| digimoncard.io | Digimon (4,444 cards) | responds, not wired |

Roughly a day's work. No purchase. Dragon Ball is named in the Product Scope
Blueprint, so it is scope rather than an extra.

## 3. What must be bought — sports

There is **no free sports catalogue anywhere**. Every reference database for
sports cards is commercial. One signup covers it:

**Card Hedge** — `ai.cardhedger.com/signup` — from **$49/mo**, 7-day trial.

Sports and TCG share one category namespace, so it is one adapter, not one per
sport. Already written and wired (`src/scans/cardhedger.ts`), off until keyed.

Ask sales for all three or the endpoints return 403:

- base API — catalogue, sets, cards, prices, comps
- **GemRate contract** — the three `population-*` endpoints
- **commercial agreement** — `sales-by-search`

```
CARDHEDGER_API_KEY=...
CARDHEDGER_DAILY_MAX=2000     # both required; either one at zero means off
```

Verify with `GET /market/quota` → `providers.cardhedger`.

**Do not buy separately:** GemRate is reachable through Card Hedge.
PriceCharting serves current values only — no history — and our card page is a
chart.

## 4. Pricing is far narrower than the catalogue

Listing a card and valuing it are different problems. Today:

| Game | Sets browsable | Graded price rows held | A valuation rests on |
|---|---:|---:|---|
| Pokémon | 218 | 246 | Completed sales, by grader and grade |
| One Piece | 22 | 3 | Almost entirely eBay asks |
| Yu-Gi-Oh! | 1,035 | 0 | eBay asks only |
| Magic | 988 | 0 | eBay asks only |
| Lorcana | 22 | 0 | eBay asks only |

The paid price provider is `pokemonpricetracker.com`. **The catalogue is five
games wide and the price engine is one game deep.** Card Hedge closes this:
`all-prices-by-card`, `comps` (completed sales) and `prices-by-card` (history).

Two live faults, neither needing a purchase:

- **`PPT_KEY_SECRET` is wrong on the AWS box.** Ten keys fail to decrypt, so
  Pokémon pricing is running on eBay asks.
- **eBay sold data was never approved.** We hold Browse (active listings) only,
  which is why the app reports "0 of 9 recorded sales".

---

## 5. What we cannot cover

Listed plainly so nothing is promised that cannot be delivered.

### Hard — no data source exists at any price

| Missing | Why |
|---|---|
| **AFL** | Select Australia is the official licensee. Checklists are web pages and a phone app; there is no API. TCDb carries some and publishes no API either. |
| **NRL / NRLW** | Same. |
| **Flesh and Blood** | `fabdb.net` timed out on every request. |

AFL and NRL are the sharpest risk: an Australian marketplace that cannot list
footy cards will be asked about it. Closing them means licensing data directly
from Select, or ingesting their checklists by hand — a commercial conversation,
not an integration.

### Unconfirmed until Card Hedge is keyed

Their spec only ever exemplifies **Baseball, Basketball, Football and
Pokemon** — all US. Soccer, Formula 1, UFC, cricket, golf and tennis are not
named anywhere in it.

**Ask sales for the full category list in writing before signing.** That single
answer decides how broad a promise can safely be made.

### No source found

Weiss Schwarz · Cardfight!! Vanguard · Sorcery: Contested Realm ·
Grand Archive · Altered · MetaZoo · Duel Masters · Battle Spirits ·
Garbage Pail Kids · Marvel & DC · Topps Star Wars · K-pop photocards ·
tobacco-era vintage

### Not a catalogue problem, but often mistaken for one

- **Population counts** — no source until the GemRate contract is signed.
- **Itemised sold listings** — eBay Marketplace Insights, pending approval, or
  Card Hedge `comps` instead.

---

## What can honestly be promised

> Every major trading card game, plus US sports, with completed-sale pricing
> and population data across PSA, BGS, SGC and CGC.

That is deliverable with one signup. **AFL and NRL are not**, and should be a
named later phase with a data-licensing line item beside them.
