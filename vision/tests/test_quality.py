from app.pipeline.detect import detect_card
from app.pipeline.quality import run_gate
from synth import make_card_photo


def _gate(**kwargs):
    photo = make_card_photo(**kwargs)
    det = detect_card(photo)
    return run_gate(det, photo.shape)


def test_clean_photo_passes():
    result = _gate()
    assert result.rejection is None
    assert result.quality.blur_score > 40
    assert result.quality.glare_pct < 1.0


def test_blurry_photo_rejected():
    result = _gate(blur_sigma=6.0)
    assert result.rejection is not None
    assert result.rejection["reason"] == "too_blurry"


def test_glare_rejected_with_located_hint():
    result = _gate(glare=True)
    assert result.rejection is not None
    assert result.rejection["reason"] == "too_much_glare"
    assert len(result.quality.glare_regions) >= 1
    assert "tilt" in result.rejection["retryHint"].lower()


def test_small_card_rejected():
    result = _gate(card_h_frac=0.28)
    assert result.rejection is not None
    assert result.rejection["reason"] in ("card_too_small", "resolution_too_low")


def test_low_resolution_grades_in_low_detail_mode():
    result = _gate(img_w=800, img_h=600)
    assert result.rejection is None
    assert result.quality.low_detail is True
    assert result.quality.resolution_ok is False


def test_tiny_photo_still_rejected():
    result = _gate(img_w=520, img_h=390)
    assert result.rejection is not None
    assert result.rejection["reason"] in ("resolution_too_low", "card_too_small")
