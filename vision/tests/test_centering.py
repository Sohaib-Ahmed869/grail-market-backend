import pytest

from app.pipeline.centering import measure_centering
from app.pipeline.detect import detect_card
from synth import make_card_photo

TOLERANCE = 3.0  # percentage points, includes warp/rotation error


def _measure(lr, tb, **kwargs):
    det = detect_card(make_card_photo(lr=lr, tb=tb, **kwargs))
    assert det is not None
    return measure_centering(det.warped)


@pytest.mark.parametrize(
    "lr,tb",
    [(50, 50), (60, 40), (40, 60), (55, 45), (35, 50), (65, 55)],
)
def test_measures_known_ratios(lr, tb):
    result = _measure(lr, tb)
    assert result.measurable
    assert result.confidence > 0.3
    assert abs(result.lr - lr) <= TOLERANCE
    assert abs(result.tb - tb) <= TOLERANCE


def test_psa_pass_thresholds():
    perfect = _measure(50, 50)
    assert perfect.passes_psa10 and perfect.passes_psa9

    edge_ten = _measure(58, 50)
    assert edge_ten.passes_psa10

    nine_only = _measure(64, 50)
    assert not nine_only.passes_psa10
    assert nine_only.passes_psa9

    fails_both = _measure(72, 50)
    assert not fails_both.passes_psa10
    assert not fails_both.passes_psa9


def test_borderless_card_is_honestly_unmeasurable():
    result = _measure(50, 50, borderless=True)
    assert not result.measurable
    assert not result.passes_psa10
