"""A slab that fills the frame is a slab, not a failure.

A clean 644x1104 PSA photo — the whole holder, edge to edge, sharp — was
rejected with "the card is too small in the frame to measure accurately" and
told to move closer. The card already filled the frame; that was the reason.

Two causes met. With no background there is no outer boundary to find, so the
detector locked onto an internal element covering 6% of the image. And the
full-frame fallback that exists for exactly this case was gated on bare-card
proportions (0.63 upward), while a slab is narrower than the card inside it at
about 0.58 — so a photo of a card was ruled not card-shaped.
"""

import numpy as np

from app.pipeline.detect import detect_card, _image_is_card_shaped


def _slab_like(w: int = 644, h: int = 1104) -> np.ndarray:
    """An image with slab proportions and real content in it."""
    rng = np.random.default_rng(7)
    img = rng.integers(0, 255, size=(h, w, 3), dtype=np.uint8)
    return img


def test_a_slab_shaped_image_counts_as_a_card():
    # PSA and BGS holders sit around 0.58-0.62, below the bare card's 0.716
    assert _image_is_card_shaped(_slab_like(644, 1104)) is True
    assert _image_is_card_shaped(_slab_like(750, 1050)) is True, "a bare card still passes"


def test_a_wildly_wrong_shape_is_still_rejected():
    assert _image_is_card_shaped(_slab_like(1000, 1100)) is False, "nearly square"
    assert _image_is_card_shaped(_slab_like(300, 1200)) is False, "a strip, not a card"


def test_a_frame_filling_slab_is_detected_not_rejected():
    det = detect_card(_slab_like())
    assert det is not None, "a slab filling the frame must not come back as nothing"
    assert det.full_frame is True
    assert det.card_area_frac == 1.0


def test_an_empty_frame_is_still_nothing():
    # card-shaped by accident, but a photo of nothing has almost no variance
    blank = np.full((1104, 644, 3), 200, dtype=np.uint8)
    assert detect_card(blank) is None
