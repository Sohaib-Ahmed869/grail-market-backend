"""The failure catalogue as executable fixtures.

Every row is a case that breaks a PSA-shaped parser. Sourced from section 8 of
docs/grading-knowledge-base.md plus the three real failures observed in
production this week.

These run against `parse_slab` directly on synthetic text blocks rather than
images: the question here is whether the EXTRACTION is correct given text, not
whether OCR read it. Image-level behaviour is covered by test_slab.py.

Expected tuple per case: (grader, grade, qualifier, label, is_slab).
`None` means "must not be asserted" — e.g. a raw card has no grade.
"""

import pytest

from app.pipeline.identify import parse_slab


def blk(*lines: str) -> list[dict]:
    """Build the OCR block shape parse_slab expects: text plus a `top` in 0..1.

    Label text sits in the upper fifth of a slab photo, which is what
    parse_slab filters on, so every synthetic line is placed there.
    """
    return [{"text": t, "top": 0.02 + i * 0.02} for i, t in enumerate(lines)]


# ─────────────────────────────────────────────────────────────────────────────
# Cases the current parser is known or suspected to fail.
# id, ocr lines, expected grader, grade, qualifier, label, is_slab
# ─────────────────────────────────────────────────────────────────────────────
CATALOGUE = [
    # ── Beckett: the whole family is currently invisible ────────────────────
    ("bgs-95-gem-mint",
     ["BGS 9.5 GEM MINT", "0012345678"],
     "BGS", 9.5, None, None, True),

    ("bgs-95-with-subgrades",
     ["BECKETT", "BGS 9.5 (10/9.5/9.5/9)", "0012345679"],
     "BGS", 9.5, None, None, True),

    ("bgs-black-label",
     ["BGS 10 BLACK LABEL", "PRISTINE", "0012345680"],
     "BGS", 10.0, None, "black", True),

    ("bgs-subgrade-captions",
     ["2006 EX DRAGON FRONTIERS", "#100 CHARIZARD DS HOLO R", "8.5",
      "CENTERING 9.5  CORNERS 8", "NM-MT+", "EDGES 9  SURFACE 8.5", "0011755115"],
     "BGS", 8.5, None, None, True),

    ("beckett-graded-spelled-out",
     ["Beckett Graded 9", "0012345681"],
     "BGS", 9.0, None, None, True),

    ("bvg-vintage",
     ["BVG 8.5", "0012345682"],
     "BVG", 8.5, None, None, True),

    # ── Beckett sub-brands that must NOT price like BGS ─────────────────────
    ("bccg-10-is-discount-tier",
     ["BCCG 10", "MINT", "0012345683"],
     "BCCG", 10.0, None, None, True),

    ("brcr-is-not-a-slab",
     ["BRCR 9", "RAW CARD REVIEW"],
     None, None, None, None, False),

    # ── PSA ─────────────────────────────────────────────────────────────────
    ("psa-plain",
     ["2002 POKEMON", "#3 CHARIZARD-REV.FOIL", "LEGENDARY COLLECTION", "EX 5",
      "41157548"],
     "PSA", 5.0, None, None, True),

    ("psa-gem-mt-10",
     ["2021 POKEMON SWSH", "#215 UMBREON VMAX", "GEM MT", "10", "85183760"],
     "PSA", 10.0, None, None, True),

    ("psa-qualifier-oc",
     ["PSA 8 (OC)", "12345678"],
     "PSA", 8.0, "OC", None, True),

    ("psa-no-space",
     ["PSA10", "12345679"],
     "PSA", 10.0, None, None, True),

    # ── CGC: two different tens ─────────────────────────────────────────────
    ("cgc-pristine-10",
     ["CGC PRISTINE 10", "1234567001"],
     "CGC", 10.0, None, "pristine", True),

    ("cgc-gem-mint-10",
     ["CGC GEM MINT 10", "1234567002"],
     "CGC", 10.0, None, "gem", True),

    ("cgc-mint-plus-95",
     ["CGC MINT+ 9.5", "1234567003"],
     "CGC", 9.5, None, None, True),

    # ── SGC: the 100-point legacy scale ─────────────────────────────────────
    ("sgc-legacy-88-is-8",
     ["SGC 88", "1234567004"],
     "SGC", 8.0, None, None, True),

    ("sgc-legacy-92-is-85",
     ["SGC 92", "1234567005"],
     "SGC", 8.5, None, None, True),

    ("sgc-modern-10",
     ["SGC 10", "1234567006"],
     "SGC", 10.0, None, None, True),

    # ── Emerging graders with decimal grades ────────────────────────────────
    ("tag-decimal",
     ["TAG 9.8", "1234567007"],
     "TAG", 9.8, None, None, True),

    # ── Negative guards: a grade token is not a graded card ─────────────────
    ("psa-10-candidate-is-raw",
     ["PSA 10 CANDIDATE", "CHARIZARD"],
     None, None, None, None, False),

    ("would-grade-is-raw",
     ["WOULD GRADE PSA 9", "MINT CONDITION"],
     None, None, None, None, False),

    ("ungraded-is-raw",
     ["UNGRADED", "NM MINT 9", "CHARIZARD"],
     None, None, None, None, False),

    ("lot-is-not-a-single-slab",
     ["LOT OF 5 PSA 10", "POKEMON"],
     None, None, None, None, False),

    ("card-number-is-not-a-grade",
     ["CHARIZARD 4/102", "BASE SET"],
     None, None, None, None, False),
]


@pytest.mark.parametrize(
    "case_id,lines,grader,grade,qualifier,label,is_slab",
    CATALOGUE,
    ids=[c[0] for c in CATALOGUE],
)
def test_catalogue(case_id, lines, grader, grade, qualifier, label, is_slab):
    got = parse_slab(blk(*lines))

    if not is_slab:
        assert got is None, f"{case_id}: expected NOT a slab, got {got}"
        return

    assert got is not None, f"{case_id}: expected a slab, got None"
    assert got.get("grader") == grader, (
        f"{case_id}: grader {got.get('grader')!r} != {grader!r}"
    )
    assert got.get("grade") == pytest.approx(grade), (
        f"{case_id}: grade {got.get('grade')!r} != {grade!r}"
    )
    if qualifier is not None:
        assert got.get("qualifier") == qualifier, (
            f"{case_id}: qualifier {got.get('qualifier')!r} != {qualifier!r}"
        )
    if label is not None:
        assert got.get("label") == label, (
            f"{case_id}: label {got.get('label')!r} != {label!r}"
        )


# ── the sealed-pack label that printed a PSA 10 as "GEM MT 1" ────────────────
# "1ST EDITION" put a 1 in the token stream, and the display string took it.
# The cascade always had the grade right; only the string people read was wrong.

def test_first_edition_does_not_become_the_grade():
    from app.pipeline.identify import parse_slab

    def t(text, top):
        return {"text": text, "top": top}

    texts = [
        t("1999 WOTC-POKEMON", 0.05),
        t("JUNGLE FOIL PACK", 0.08),
        t("1ST EDITION-SCYTHER", 0.11),
        t("GEM MT", 0.08),
        t("10", 0.08),
        t("26869245", 0.11),
    ]
    slab = parse_slab(texts)
    assert slab is not None
    assert slab["grade"] == 10.0
    # the string a person reads must carry the same number as the tuple
    assert "10" in slab["gradeText"], slab["gradeText"]
    assert not slab["gradeText"].rstrip().endswith(" 1"), slab["gradeText"]
    # "1ST" is an ordinal, not card #1 - a sealed pack has no card number
    assert slab["cardNumber"] != "1", slab["cardNumber"]


# ── One Piece prints treatment markers flush against the card number ─────────
# "SP OP07-085 SR" is one token to OCR. With \b anchors on both ends the code
# had to stand alone, so a raw card with a perfectly legible number read as
# having none, matched nothing, and was priced at nothing.

def test_one_piece_code_survives_its_treatment_markers():
    from app.pipeline.identify import SET_CODE_RE

    def code(t):
        m = SET_CODE_RE.search(t)
        return f"{m.group(1).upper()}-{m.group(2)}" if m else None

    assert code("SPOP07-085SR") == "OP07-085"     # exactly what OCR returned
    assert code("SP OP07-085 SR") == "OP07-085"
    assert code("OP13-119") == "OP13-119"
    assert code("ST01-001") == "ST01-001"
    assert code("EB01-012") == "EB01-012"
    # still anchored enough not to invent codes out of longer runs
    assert code("TOP07-0855") is None


# ── a decorative glyph is not a Japanese printing ───────────────────────────
# One Piece prints 特 ("SPECIAL") on ENGLISH cards. Treating any CJK character
# as proof of a Japanese printing priced an English Stussy SP against the
# Japanese one - $130 versus $100, a different card in a different market.

def test_single_glyph_is_not_a_japanese_printing():
    import re

    def is_japanese(text):
        kana = len(re.findall(r"[぀-ヿ]", text))
        kanji = len(re.findall(r"[一-鿿]", text))
        return kana >= 2 or kanji >= 6

    # the English Stussy, exactly as OCR returned it
    assert not is_japanese("9000 特 OnPlay Youmaytrash1ofyourCharacters 商 CHARACTE Stussy CPO SPOP07-085SR")
    # the Japanese Ace, likewise
    assert is_japanese("ポートガス・D・エース 白ひげ海賊団 自分のライフが3枚以下の場合")
    assert not is_japanese("Charizard Base Set 4/102 PSA 9")


# ── a mangled year is not a card number ─────────────────────────────────────
# PSA's "2021 POKEMON SWSH" came back from OCR as "2O2TPOKEMONSWSH" — 0 read as
# O, 1 as T. The leading-digit rule fired on its 2, claimed the card number, and
# the perfectly readable "#215" two tokens later never got a look. Evolving
# Skies #2 is a Hoppip; #215 is the Umbreon VMAX alt art.

def test_hash_number_beats_a_mangled_year():
    from app.pipeline.identify import parse_slab

    def t(text, top):
        return {"text": text, "top": top}

    texts = [
        t("2O2TPOKEMONSWSH", 0.04),
        t("#215", 0.04),
        t("FA/UMBREONVMAX", 0.07),
        t("GEMMT", 0.07),
        t("EVOLVINGSKIES-SECRET", 0.10),
        t("10", 0.07),
        t("PSA", 0.10),
        t("85183760", 0.10),
    ]
    slab = parse_slab(texts)
    assert slab is not None
    assert slab["cardNumber"] == "215", slab["cardNumber"]
    # repairing the year also recovers it, and cleans it out of the set line
    assert slab["year"] == "2021", slab["year"]
    assert "POKEMON" in (slab["setLine"] or ""), slab["setLine"]
    assert slab["grade"] == 10.0


def test_a_leading_number_is_still_a_card_number_when_it_is_one():
    from app.pipeline.identify import parse_slab

    def t(text, top):
        return {"text": text, "top": top}

    # no "#" anywhere, and "100CHARIZARD" is genuinely card 100 — the fallback
    # must still work, or the fix trades one wrong card for another
    slab = parse_slab([
        t("2006 POKEMON EX", 0.04),
        t("100CHARIZARD", 0.07),
        t("DRAGON FRONTIERS", 0.10),
        t("GEM MT", 0.07),
        t("10", 0.07),
        t("12345678", 0.10),
    ])
    assert slab is not None
    assert slab["cardNumber"] == "100", slab["cardNumber"]
