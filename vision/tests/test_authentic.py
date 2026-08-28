"""PSA's non-numeric designations.

"AUTHENTIC" is not a grade — it is PSA saying the card is genuine without
assigning one. Sample cards, some promos and altered cards get it. The parser
had no concept of it, so a PSA AUTHENTIC slab came back with grade=None, and
grade=None is what the scan path checks before it will fetch anything at all.
The result was a card with no price and no listings, from a holder whose
market is visible on eBay right now.

The designation has to survive as a designation. Inventing a number for it
would be worse than the blank was.
"""

from app.pipeline.slab import extract


def test_authentic_is_read_as_a_slab_without_a_number():
    r = extract("PSA AUTHENTIC MONKEY D LUFFY OP05-119 121228619")
    assert r.grader == "PSA"
    assert r.is_slab is True
    assert r.grade is None, "Authentic carries no numeric grade; do not invent one"
    assert r.qualifier == "AUTHENTIC"


def test_a_number_printed_beside_authentic_is_not_the_grade():
    # the label the scan actually produced. Whatever that 10 is, PSA did not
    # grade this card a 10 — it declined to grade it at all.
    r = extract("PSA AUTHENTIC 10 MONKEY D LUFFY OP05-119")
    assert r.grader == "PSA"
    assert r.grade is None
    assert r.qualifier == "AUTHENTIC"


def test_authentic_altered_is_still_authentic():
    r = extract("PSA AUTHENTIC ALTERED CHARIZARD BASE SET")
    assert r.grader == "PSA"
    assert r.grade is None
    assert r.qualifier == "AUTHENTIC"


def test_a_real_psa_grade_is_untouched():
    # the counter-case: this must not start swallowing numeric PSA grades
    r = extract("PSA GEM MT 10 MONKEY D LUFFY OP05-119")
    assert r.grader == "PSA"
    assert r.grade == 10.0
    assert r.qualifier is None


def test_a_qualifier_grade_is_untouched():
    r = extract("PSA 8 (OC) CHARIZARD")
    assert r.grader == "PSA"
    assert r.grade == 8.0
    assert r.qualifier == "OC"
