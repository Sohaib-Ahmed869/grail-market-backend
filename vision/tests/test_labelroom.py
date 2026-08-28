"""Whether a photo might still be hiding a grading label.

This decides if we take a second look at the full frame for a slab label. A
false negative here is silent and expensive: the label is never read, the card
reports as raw, and a graded card gets quoted at its ungraded price with
nothing on screen suggesting a problem. A false positive costs one extra OCR
pass. The fixtures below pin that asymmetry.
"""

from app.pipeline.report import _room_for_a_label


def test_cgc_slab_photographed_close():
    # The real failure. A CGC 8.5 Armored Mewtwo filled 66.06% of the frame and
    # the old test was `< 0.65`, so the label was never looked for and the card
    # was priced as raw. It missed by one point of a percent.
    assert _room_for_a_label(0.6606, 0.10) is True


def test_a_slab_always_has_something_above_the_card():
    # Geometry, not luck: the label sits above the card, so a slabbed card
    # cannot start at the top of the frame. Even a very tightly cropped slab
    # is caught by the headroom.
    assert _room_for_a_label(0.92, 0.12) is True


def test_a_raw_card_filling_the_frame_is_not_re_read():
    # No headroom and nearly the whole frame — there is nowhere for a label to
    # be, so we do not pay for a second pass.
    assert _room_for_a_label(0.95, 0.01) is False


def test_a_loosely_framed_card_is_worth_a_look():
    # Plenty of frame that is not card. Cheap to check, costly to skip.
    assert _room_for_a_label(0.40, 0.0) is True


def test_missing_measurements_do_not_assert_a_label():
    # Nothing detected: we know nothing, and inventing a reason to re-read is
    # not the same as having one.
    assert _room_for_a_label(None, None) is False
