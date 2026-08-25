# Trading Card Grading & Valuation — Engineering Knowledge Base

## 1. The mental model

- **Raw** — ungraded. Value driven by seller-declared condition claims.
- **Slabbed** — sealed by a third-party grader with a printed grade and a cert.

> A grade is not a property of the card. It is a property of the card *plus the
> company that issued it.* Treat grader and grade as a composite key, never as a
> normalised single number.

## 2. The grading companies

### PSA
Scale 1-10, half grades at low/mid (1.5 … 8.5). **There is no PSA 9.5.**
Labels: 10 Gem Mint, 9 Mint, 8 NM-MT. No subgrades on the modern label.
**Qualifiers** slash value 40-70%: OC off-centre, ST stain, MK marks,
PD print defect, MC miscut. Written `PSA 8 (OC)` or `PSA 8OC`.
Certs 8-9 digits, publicly verifiable.

### BGS / Beckett
Scale 1-10 in **0.5 increments — BGS 9.5 exists and is common.**
**Subgrades**: Centering, Corners, Edges, Surface, each 1-10 in 0.5 steps.
Titles carry them: `BGS 9.5 (9.5/9.5/10/9)`.
**The overall is NOT the average** — it is rules-based and penalises the lowest
subgrade. Read it, never compute it.
Label colours carry value: **Black Label** = BGS 10 with all four subgrades 10,
frequently a multiple of a PSA 10. Gold = BGS 10 / 9.5 otherwise. Silver = rest.

Sub-brands not to confuse:
- **BVG** Beckett Vintage Grading — vintage, same scale.
- **BCCG** Beckett Collectors Club — a much looser consumer tier. **A BCCG 10 is
  worth a small fraction of a BGS 10**, often less than a raw NM card. Mapping
  BCCG 10 -> PSA 10 overvalues by 10-50x. Classic scam vector.
- **BAS** autograph authentication, not condition.
- **BRCR** Beckett Raw Card Review — an opinion grade in a non-tamper-evident
  sleeve. **Not a slab.** Price as raw.

### CGC
Unusual top: Pristine 10 > Gem Mint 10 > Mint+ 9.5 > Mint 9 > NM-MT+ 8.5.
**Two different 10s** — "CGC 10" alone is ambiguous.

### SGC
Modern 1-10 with half grades. **Legacy trap:** older slabs use a 100-point
scale. SGC 98 = 9, 96 = 9, 92 = 8.5, 88 = 8, 86 = 7.5, 84 = 7.

### Emerging / discount
TAG, ACE, AGS grade to one decimal (`TAG 9.8`). GMA, KSA, HGA are soft graders
trading at a steep discount regardless of the number. CSG wound down.

**Rule:** maintain grader_tier (premium / emerging / discount) and never price
across tiers.

## 3. Why BGS -> PSA conversion is wrong

1. **The ladders don't align.** PSA has no 9.5; CGC has two 10s; SGC vintage is
   100-point. There is no bijection.
2. **Strictness differs per band.** BGS 9.5 ~ PSA 10 in condition, but a BGS 10
   is far stricter than a PSA 10.
3. **Price is set by liquidity, not condition.** In modern Pokemon a PSA 10
   typically carries 1.5-3x over a BGS 9.5 purely because PSA's market is
   deepest. In some vintage sports niches it inverts. Black Label sits above
   everything. The ratio varies by category, era, card and month.

## 8. Failure catalogue — build fixtures from these

| Input fragment | Correct interpretation | Common bug |
|---|---|---|
| `BGS 9.5 GEM MINT` | BGS, 9.5 | Dropped (no 9.5 on PSA scale) |
| `BGS 9.5 (10/9.5/9.5/9)` | BGS 9.5 + subgrades | Parser grabs the 10 |
| `BGS 10 BLACK LABEL` | Top of market, premium | Priced as an ordinary 10 |
| `BCCG 10` | Discount tier, low value | Priced as a gem 10 |
| `BVG 8.5` | Vintage Beckett | Unknown grader -> dropped |
| `RCR 9` / `Raw Card Review` | **Raw**, not slabbed | Priced as a slab |
| `SGC 88` | Legacy scale = SGC 8 | Nonsense grade or dropped |
| `CGC 10` | Ambiguous: Pristine or Gem Mint | Assumed the higher |
| `PSA 8 (OC)` | Qualified, heavily discounted | Priced as clean PSA 8 |
| `PSA 10 CANDIDATE` | Raw, seller opinion | Priced as PSA 10 |
| `CHARIZARD 4/102 PSA 9` | Grade 9; 4/102 is the number | 102 or 4 read as grade |
| `LOT OF 5 PSA 10` | Multi-card lot | Single-card price on a lot |
| `PSA10` (no space) | PSA 10 | Regex requires whitespace |
| `Beckett Graded 9` | BGS 9 | Only matches literal BGS |
| `TAG 9.8` | Decimal, emerging grader | Integer-only regex |

## 6. Pricing methodology

Sold comps not asks. Median not mean. Trailing window with a minimum sample;
widen the window before widening the grade band. Trim outliers at p10/p90.
Exclude lots, damaged/altered, reprints, proxies. Watch pop reports — pop is the
sanity check on a suspiciously high estimate. Always return confidence and
sample size.
