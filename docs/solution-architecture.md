# Card Identification & Valuation Platform — Solution Architecture

**Status:** Approved · **Scope:** identification, slab extraction, valuation, listing guidance

---

## 1. Executive summary

| # | Problem | Impact |
|---|---|---|
| P1 | Grade extraction is PSA-shaped; Beckett and other graders are dropped | Silent data loss on a large share of slabs |
| P2 | Grades are normalised across graders (BGS -> PSA) | Measured ~$12,000 error on a single card |
| P3 | Identification relies on whole-image OCR | Wrong card on foils, angles, small numbers, non-Latin |

| # | Gap | Impact |
|---|---|---|
| G1 | No owned sales history | Permanently dependent on a 90-day vendor window |
| G2 | No confidence model | Every answer looks equally trustworthy, including wrong ones |

**Guiding principle:** a missing answer is cheap; a confident wrong answer is expensive.
Every stage must be able to return "unknown" with a reason.

## 2. Stage responsibilities

| Stage | Input | Output | Fails to |
|---|---|---|---|
| 1 Normalise | raw image / text | deskewed image, cleaned tokens | reject unusable input |
| 2a Label OCR | slab crop | label text block | fall through to 2b |
| 2b Card-face read | card crop | face tokens + embedding | identity: unknown |
| 3 Slab extraction | label text | grader, grade, subgrades, qualifier, cert | slab: unknown |
| 4 Identity resolution | tokens + embedding + cert | catalog_card_id + confidence | identity: unknown |
| 5 Valuation | card_id + slab state | price + comps + confidence | no_comp |
| 6 Listing guidance | valuation | three-point range + provenance | suppress if low confidence |

## 3. Stage 1 - Image normalisation

1. Rectangle detection - largest 4-point convex contour.
2. Perspective correction to a fixed canonical size.
3. Slab classification - aspect ratio + high-luminance band in the upper ~20%.
4. Region crops at fixed relative coordinates: label, title, number, art.
5. Per-region preprocessing - CLAHE for foil glare; 3-4x upscale on the number crop.

> Highest-value change: stop OCRing the whole image. Region-targeted OCR on a
> deskewed crop outperforms any engine swap.

## 4. Stage 2 - Reading

**2a Slab path (preferred).** A grading label is flat, matte, high-contrast text
with no holo interference, and usually carries year, set, number, name, grade,
subgrades and cert in one read. Route slabs here first.

**2b Raw / fallback.** OCR title and number crops separately; compute a
perceptual hash and an embedding of the art crop. Neither signal is trusted alone.

**2c VLM fallback.** Only when 2a and 2b are both low confidence. Log every
invocation so the primary pipeline's failure rate is measurable.

## 5. Stage 3 - Slab extraction

### 5.1 The grade is a tuple, not a number

```json
{
  "grader": "BGS", "grade": 8.5, "qualifier": null, "label": "silver",
  "subgrades": {"centering": 9.5, "corners": 8, "edges": 9, "surface": 8.5},
  "cert": "0011755115", "tier": "premium"
}
```

tier: premium (PSA, BGS, CGC, SGC) | emerging (TAG, ACE, AGS) | discount
(GMA, KSA, HGA, BCCG). Never price across tiers.

### 5.2 Ordered regex cascade

Order is load-bearing - specific patterns must fire before generic ones.

```
1.  BGS Black Label      BGS 10 + BLACK LABEL
2.  BGS with subgrades   BGS 9.5 (10/9.5/9.5/9)
3.  BGS plain            BGS|BECKETT [GEM MINT|PRISTINE] 9.5
4.  BVG                  vintage Beckett
5.  BCCG                 -> tier = discount
6.  BRCR / Raw Card Rev. -> is_slab = false
7.  PSA + qualifier      PSA 8 (OC|ST|MK|PD|MC)
8.  PSA plain
9.  CGC                  PRISTINE 10 | GEM MINT 10 | MINT+ 9.5
10. SGC modern           <= 10
11. SGC legacy           84|86|88|92|96|98 -> 7|7.5|8|8.5|9|9
12. TAG / ACE / AGS      decimal grades
```

### 5.3 Negative guards

Reject on: CANDIDATE, WOULD GRADE, READY FOR, PRE-GRADE, NOT GRADED, UNGRADED,
a `?` following the grade, an adjacent `#`/fraction (10/102), or lot markers
(LOT, BUNDLE, x5, PICK, CHOOSE).

### 5.4 Cert-first shortcut

A verified cert yields authoritative identity and grade, skipping fuzzy matching.
Highest-precision path in the system.

## 6. Stage 4 - Identity resolution

| Signal | Weight |
|---|---|
| Cert lookup | decisive - short-circuit |
| set + card_number | high |
| Image embedding / pHash | high |
| Character / player name | low |

Block on category + year + set before scoring. If the top candidate's margin
over the second is below threshold, return identity: ambiguous with the list.

## 7. Stage 5 - Valuation

### 7.2 The composite key

`(catalog_id, grader, grade, qualifier, label_variant)`.
**There is no grade-only lookup anywhere in the system.** Removing that
possibility from the schema is what prevents P2 from returning.

### 7.3 Estimation ladder

```
1. Exact key, trailing 90d, n >= 3, trim p10..p90, median   HIGH
2. Same grader, adjacent grade, learned ratio               MEDIUM
3. Different grader via measured per-category ratio         LOW
4. Raw price x category grading multiplier                  VERY_LOW
5. Otherwise no_comp                                        NONE
```

Cross-grader ratios are measured from our own ledger, never hand-written.

### 7.4 Exclusions

Drop lots, ALTERED, DAMAGED, PROXY, REPRINT, custom/fan cards, and sales beyond
3 IQR from the window median. Log exclusions - a spike means parser regression.

## 8. Stage 6 - Listing guidance

Sold is not ask. Return quick_sale / market / patient_ask plus last_sale and
sample_size. Always render last_sale.at so a stale comp is visibly stale.
Below MEDIUM, show a range and a caveat. At NONE, show "no recent sales".

## 9. Data sourcing

| Layer | Choice | Rationale |
|---|---|---|
| Sold comps | SoldComps (or adapter impl) | category-agnostic, no approval gate |
| Catalog + images | TCGdex / Scryfall / YGOPRODeck | free, feeds identity |
| Cert verification | PSA cert API; Beckett/CGC/SGC lookup | highest precision |

Rejected: PriceCharting (collapses graders below 10), eBay Marketplace Insights
(Limited Release), eBay Finding API (decommissioned), Collectr (terms),
DIY scraping (login wall since 22 July 2026).

### 9.1 The 90-day ceiling

eBay exposes ~90 days of completed sales. Competitors show multi-year history
because they have been storing daily for years. The comp harvester is therefore
the highest-leverage job in the system - every day it does not run is history
that cannot be recovered.

## 10. Confidence model

| Level | Identity | Valuation |
|---|---|---|
| HIGH | cert verified, or set+number+image agree | exact key, n>=3, <=90d |
| MEDIUM | two signals agree | adjacent grade, same grader |
| LOW | one signal only | cross-grader ratio |
| VERY_LOW | fuzzy name match | derived from raw |
| NONE | ambiguous | no comp |

Every response carries confidence and reasons[]. Everything below MEDIUM is
logged with its inputs - that log is the prioritised backlog.

## 13. Definition of done for Phase 0

- [ ] Every fixture parses to the correct (grader, grade, qualifier, label)
- [ ] BCCG 10 prices as discount tier, not a gem 10
- [ ] SGC 88 resolves to grade 8
- [ ] BGS 9.5 (10/9.5/9.5/9) yields overall 9.5, not 10
- [ ] PSA 10 CANDIDATE classifies as raw
- [ ] No code path can look up a price by grade alone
- [ ] Comp harvester has written its first 1,000 rows
