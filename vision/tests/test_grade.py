import cv2
import numpy as np

from app.pipeline import run_pipeline
from app.pipeline.centering import measure_centering
from app.pipeline.detect import detect_card
from app.pipeline.grade import compute_grade
from synth import make_card_photo


def _grade(photo):
    det = detect_card(photo)
    assert det is not None
    return compute_grade(det.warped, measure_centering(det.warped))


def test_clean_card_grades_high():
    g = _grade(make_card_photo(lr=50, tb=50))
    assert g.overall >= 8.5
    assert g.band_low < g.overall < g.band_high or g.band_high == 10.0
    assert g.centering is not None and g.centering.value >= 9.5
    assert g.corners.value >= 9.0
    assert g.edges.value >= 9.0


def test_off_center_card_capped_by_centering():
    clean = _grade(make_card_photo(lr=50, tb=50))
    off = _grade(make_card_photo(lr=72, tb=50))
    assert off.centering.value < clean.centering.value
    assert off.overall < clean.overall


def test_worn_corner_lowers_corner_grade():
    photo = make_card_photo(lr=50, tb=50)
    det = detect_card(photo)
    bg = (45, 42, 40)  # the synthetic background color
    # a worn/rounded corner lets the background show deeper than factory
    # rounding — simulate it and judge with the geometric corner check
    worn = det.warped.copy()
    cv2.circle(worn, (0, 0), 34, bg, -1)
    g_clean = compute_grade(det.warped, measure_centering(det.warped), bg_color=bg)
    g_worn = compute_grade(worn, measure_centering(worn), bg_color=bg)
    assert g_clean.corners is not None and g_worn.corners is not None
    assert g_worn.corners.value < g_clean.corners.value


def test_scratch_lowers_surface_grade():
    photo = make_card_photo(lr=50, tb=50)
    det = detect_card(photo)
    scratched = det.warped.copy()
    cv2.line(scratched, (150, 200), (600, 700), (255, 255, 255), 2)
    g_clean = compute_grade(det.warped, measure_centering(det.warped))
    g_scr = compute_grade(scratched, measure_centering(scratched))
    assert g_scr.surface.value < g_clean.surface.value


def test_pipeline_issues_no_grade():
    """We identify and price cards; we do not grade them.

    compute_grade still exists and is still tested above — it is simply no
    longer wired into the pipeline. The heuristics were not good enough to move
    money: they scored a clean card 2.5 on 69 phantom "surface marks", and that
    grade was then multiplying the market price by 0.25.
    """
    result = run_pipeline(make_card_photo(lr=60, tb=45))
    assert result["ok"] is True
    assert result["grade"] is None
    assert result["measurement"] is None
    # authenticity is a property of the image, not a condition opinion — kept
    assert result["authenticity"] is not None
    assert "digitalLikely" in result["authenticity"]


def test_render_flagged_as_digital():
    result = run_pipeline(cv2.imread("tests/fixtures/slowbro_render.png"))
    assert result["authenticity"]["digitalLikely"] is True
