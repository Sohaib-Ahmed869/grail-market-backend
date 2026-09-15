"""The small type that says which printing a card is.

A name matches dozens of printings; the collector number or set code picks one.
On 63 scans the first OCR pass returned no number at all, so the bands where
games print them are read again enlarged. These pin the geometry of that
re-read, and the rule that a raw card is not declined as a slab just because
it has room above it.
"""

from app.pipeline.identify import REREAD_BANDS, _band_to_card_texts, _has_printing_code
from app.pipeline.report import _label_evidence


def _t(text, top):
    return {"text": text, "score": 0.9, "top": top, "height": 0.02, "left": 0.1}


def test_a_number_read_first_time_needs_no_second_pass():
    assert _has_printing_code([_t("Charizard", 0.05), _t("4/102", 0.93)]) is True


def test_a_one_piece_code_anywhere_counts():
    assert _has_printing_code([_t("OP05-119", 0.88)]) is True


def test_a_fraction_high_on_the_card_is_not_a_collector_number():
    # attack damage and HP live up top; only the bottom band holds the number
    assert _has_printing_code([_t("30/60", 0.40)]) is False


def test_nothing_read_means_re_read():
    assert _has_printing_code([_t("Blue-Eyes White Dragon", 0.04)]) is False


def test_re_read_boxes_land_where_they_are_on_the_card():
    # An 800px-tall card, bottom band from 0.80, enlarged 2x. A box at y=40..60
    # in the enlarged crop is 20..30px into the band: 640+20 = 660px = 0.825.
    box = [(100, 40), (300, 40), (300, 60), (100, 60)]
    [t] = _band_to_card_texts([(box, " 4/102 ", 0.8)], 0.80, 800, 560, 2.0)
    assert t["text"] == "4/102"
    assert abs(t["top"] - 0.825) < 1e-9
    assert abs(t["height"] - (10 / 800)) < 1e-9
    assert abs(t["left"] - (50 / 560)) < 1e-9


def test_the_re_read_covers_both_places_codes_are_printed():
    # under the artwork (Yu-Gi-Oh, One Piece) and the bottom edge (Pokemon,
    # Magic, Lorcana, sports)
    assert REREAD_BANDS[0][0] < 0.80 <= REREAD_BANDS[1][0]
    assert REREAD_BANDS[-1][1] == 1.0


def test_a_grading_label_is_evidence_of_a_slab():
    assert _label_evidence(["PSA", "GEM MT 10", "2023 POKEMON"]) is True
    assert _label_evidence(["BGS 9.5"]) is True
    assert _label_evidence(["CGC Pristine 10"]) is True


def test_a_raw_card_with_room_above_it_is_not_a_slab():
    # Four raw cards were declined as unreadable slabs on framing alone.
    assert _label_evidence(["Charizard", "4/102", "Fire Spin"]) is False
    # Pokemon prints TAG TEAM on the card face; TAG is not label evidence.
    assert _label_evidence(["Pikachu & Zekrom GX", "TAG TEAM"]) is False
    assert _label_evidence([]) is False
    assert _label_evidence(None) is False
