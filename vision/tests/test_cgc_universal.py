"""CGC holders that a Beckett matcher was claiming.

A CGC 8.5 Armored Mewtwo came back as BGS 8.5. The label says "CGC UNIVERSAL
GRADE", but OCR routinely loses the three small letters of the logo while
keeping the two large words beside it — and CGC prints subgrade captions
(Centering / Surface / Corners / Edges) that a Beckett caption matcher is
happy to accept. Filing a CGC card under Beckett breaks the first invariant in
the book: a grade belongs to a card AND the company that issued it.
"""

from app.pipeline.slab import extract


def test_universal_grade_is_cgc_even_when_the_logo_is_lost():
    # exactly what OCR returned from the real photograph — no "CGC" anywhere
    text = (
        "UNIVERSAL GRADE Armored Mewtwo Pokemon (2019) Japanese "
        "Sun & Moon Promos - 365/SM-P Mewtwo Strikes Back - Evolution "
        "NM/Mint+ 8.5 Centering 9.5 Surface 8 Corners 10 Edges 10"
    )
    r = extract(text)
    assert r.grader == "CGC", f"got {r.grader}"
    assert r.grade == 8.5


def test_an_explicit_cgc_label_still_reads_as_cgc():
    r = extract("CGC UNIVERSAL GRADE Charizard GEM MINT 9.5")
    assert r.grader == "CGC"
    assert r.grade == 9.5


def test_cgc_keeps_its_two_different_tens_apart():
    pristine = extract("CGC UNIVERSAL GRADE Pikachu PRISTINE 10")
    gem = extract("CGC UNIVERSAL GRADE Pikachu GEM MINT 10")
    assert pristine.grader == "CGC" and pristine.label == "pristine"
    assert gem.grader == "CGC" and gem.label == "gem"


def test_beckett_is_still_beckett():
    # the counter-case: a real BGS label with its own captions must not be
    # dragged over to CGC by this
    r = extract(
        "BECKETT BGS 9.5 GEM MINT CENTERING 9.5 CORNERS 9.5 EDGES 9.5 SURFACE 9"
    )
    assert r.grader == "BGS"
    assert r.grade == 9.5
