import base64

import cv2
import numpy as np

from app.pipeline import run_pipeline
from synth import make_card_photo


def test_full_pipeline_contract():
    result = run_pipeline(make_card_photo(lr=60, tb=45))
    assert result["ok"] is True
    assert result["rejection"] is None

    q = result["quality"]
    assert set(q) == {
        "blurScore",
        "glarePct",
        "glareRegions",
        "cardAreaPct",
        "resolutionOk",
        "lowDetail",
    }

    # no grade, no centering measurement — we identify and price, we do not grade
    assert result["measurement"] is None
    assert result["grade"] is None

    # the warped card is still returned for display; there is no longer an
    # annotated overlay because nothing is being annotated
    raw = base64.b64decode(result["warpedImageB64"])
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    assert img is not None and img.shape == (1050, 750, 3)
    assert result["overlayImageB64"] is None


def test_rejection_contract():
    result = run_pipeline(make_card_photo(blur_sigma=6.0))
    assert result["ok"] is False
    assert result["measurement"] is None
    assert result["rejection"]["reason"] == "too_blurry"
    assert result["rejection"]["retryHint"]
