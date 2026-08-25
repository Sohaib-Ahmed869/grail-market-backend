import numpy as np

from app.pipeline.detect import detect_card
from synth import BG, make_card_photo


def test_finds_and_warps_card():
    det = detect_card(make_card_photo())
    assert det is not None
    assert det.warped.shape == (1050, 750, 3)
    assert det.card_area_frac > 0.25
    assert det.source_short_side_px > 450


def test_no_card_returns_none():
    empty = np.full((1200, 1600, 3), BG, dtype=np.uint8)
    assert detect_card(empty) is None


def test_handles_landscape_orientation():
    det = detect_card(make_card_photo(angle_deg=90 + 6))
    assert det is not None
    assert det.warped.shape == (1050, 750, 3)
