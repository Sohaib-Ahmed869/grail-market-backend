"""Which grading companies the label reader knows.

A 2023 Bowman Josue De Paula #BP83 in a GMG 10 holder was read as a RAW card:
GMG appeared in no list on this side, the cert fallback needs 7-10 digits and
that label prints six, so extract() fell through to "no grader/grade pattern
matched". The scan then priced it against loose copies at A$1.39-A$7.71 while
the same slab asked US$24.50 on eBay.

Every pattern is now built from slab.TIERS. These fixtures are what stops the
three copies drifting apart again.
"""

import pytest

from app.pipeline.identify import _SLAB_COMPANIES
from app.pipeline.slab import TIERS, extract


def test_the_card_that_started_it():
    r = extract("GMG 2023 BOWMAN JOSUE DE PAULA ROOKIE #BP83 GEM MINT 10 294169")
    assert r.is_slab is True
    assert r.grader == "GMG"
    assert r.grade == 10.0
    assert r.tier == "emerging"


@pytest.mark.parametrize(
    "text, grader, grade",
    [
        ("GMG 10 GEM MINT JOSUE DE PAULA #BP83", "GMG", 10.0),
        ("ISA 9 CHARIZARD BASE SET", "ISA", 9.0),
        ("PGI 8.5 PIKACHU", "PGI", 8.5),
        ("WCG 7 MICKEY MANTLE", "WCG", 7.0),
        ("CGA 9.5 JORDAN FLEER", "CGA", 9.5),
        # in TIERS all along, but the hand-written fallback never listed them
        ("HGA 10 PIKACHU", "HGA", 10.0),
        ("GMA 9 CHARIZARD", "GMA", 9.0),
        ("KSA 10 SEALED PACK", "KSA", 10.0),
        ("CSG 9.5 TOPPS CHROME", "CSG", 9.5),
        ("MNT 10 LUFFY", "MNT", 10.0),
    ],
)
def test_the_newer_companies_are_slabs(text, grader, grade):
    r = extract(text)
    assert r.is_slab is True, text
    assert r.grader == grader
    assert r.grade == grade


def test_a_multi_word_company_survives_ocr_spacing():
    # OCR gives back whatever whitespace it feels like between the two words.
    for text in ("ARENA CLUB 10 JOSUE DE PAULA", "ARENA  CLUB 10 JOSUE DE PAULA"):
        r = extract(text)
        assert r.grader == "ARENA CLUB", text
        assert r.grade == 10.0


@pytest.mark.parametrize(
    "text, grader, grade",
    [
        ("PSA 2023 BOWMAN JOSUE DE PAULA GEM MINT 10 29416900", "PSA", 10.0),
        ("BCCG 10 MINT CHARIZARD", "BCCG", 10.0),
        ("BVG 8.5 CHARIZARD", "BVG", 8.5),
    ],
)
def test_the_companies_that_already_worked_still_do(text, grader, grade):
    r = extract(text)
    assert r.grader == grader
    assert r.grade == grade


def test_a_raw_card_is_still_raw():
    r = extract("JOSUE DE PAULA ROOKIE 2023 BOWMAN #BP83")
    assert r.is_slab is False
    assert r.grader is None


def test_the_identify_gate_knows_every_tiered_company():
    # identify.py gates the label BEFORE slab.py parses it. When the two lists
    # disagree, the company is dropped even though the grade was read.
    for company in TIERS:
        assert _SLAB_COMPANIES.search(f"{company} 10 SOME CARD"), company
