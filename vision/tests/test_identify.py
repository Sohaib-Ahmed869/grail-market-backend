import cv2

from app.pipeline import run_pipeline
from app.pipeline.detect import detect_card
from app.pipeline.identify import read_card_text

FIXTURE = "tests/fixtures/slowbro_render.png"


def test_reads_name_from_low_res_render():
    det = detect_card(cv2.imread(FIXTURE))
    assert det is not None
    ocr = read_card_text(det.warped)
    assert ocr["nameCandidates"], "expected at least one name candidate"
    assert "slowbro" in ocr["nameCandidates"][0].lower()


def test_rejected_scan_still_carries_ocr():
    result = run_pipeline(cv2.imread(FIXTURE))
    assert result["ok"] is False
    assert result["rejection"]["reason"] == "resolution_too_low"
    assert result["ocr"] is not None
    assert result["ocr"]["nameCandidates"]
