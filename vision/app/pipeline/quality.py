"""The quality gate. Bad input gets rejected with a concrete retry hint,
never silently graded."""

from dataclasses import dataclass, field

import cv2
import numpy as np

from .config import CONFIG
from .detect import Detection


@dataclass
class QualityReport:
    blur_score: float
    glare_pct: float
    glare_regions: list[dict] = field(default_factory=list)  # normalised 0..1 boxes
    card_area_pct: float = 0.0
    resolution_ok: bool = True
    low_detail: bool = False  # between hard and soft resolution floors


@dataclass
class GateResult:
    quality: QualityReport
    rejection: dict | None  # {reason, userMessage, retryHint} or None


def measure_quality(det: Detection) -> QualityReport:
    cfg = CONFIG.quality
    warped = det.warped
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)

    blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    hsv = cv2.cvtColor(warped, cv2.COLOR_BGR2HSV)
    specular = (
        (hsv[..., 2] >= cfg.glare_v_min) & (hsv[..., 1] <= cfg.glare_s_max)
    ).astype(np.uint8)
    total = specular.size
    n, _, stats, _ = cv2.connectedComponentsWithStats(specular, connectivity=8)

    h, w = gray.shape
    glare_px = 0
    regions = []
    for i in range(1, n):  # 0 is background
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < cfg.glare_min_cluster_frac * total:
            continue
        glare_px += area
        regions.append(
            {
                "x": float(stats[i, cv2.CC_STAT_LEFT] / w),
                "y": float(stats[i, cv2.CC_STAT_TOP] / h),
                "w": float(stats[i, cv2.CC_STAT_WIDTH] / w),
                "h": float(stats[i, cv2.CC_STAT_HEIGHT] / h),
            }
        )

    return QualityReport(
        blur_score=blur_score,
        glare_pct=float(100.0 * glare_px / total),
        glare_regions=regions,
        card_area_pct=float(100.0 * det.card_area_frac),
        resolution_ok=det.source_short_side_px >= CONFIG.detect.min_source_width_px,
        low_detail=CONFIG.detect.hard_min_source_width_px
        <= det.source_short_side_px
        < CONFIG.detect.min_source_width_px,
    )


def _glare_hint(regions: list[dict]) -> str:
    if not regions:
        return "Tilt the card slightly away from the light source and re-shoot."
    cx = regions[0]["x"] + regions[0]["w"] / 2
    cy = regions[0]["y"] + regions[0]["h"] / 2
    vert = "upper" if cy < 0.5 else "lower"
    horiz = "left" if cx < 0.5 else "right"
    return (
        f"Glare is covering the {vert}-{horiz} area of the card. "
        "Tilt the card about 15 degrees away from the light and re-shoot."
    )


def run_gate(det: Detection | None, image_shape: tuple) -> GateResult:
    """Apply the gate in order of most-fundamental failure first."""
    dcfg, qcfg = CONFIG.detect, CONFIG.quality

    if det is None:
        return GateResult(
            quality=QualityReport(blur_score=0.0, glare_pct=0.0),
            rejection={
                "reason": "card_not_found",
                "userMessage": "We couldn't find a card in this photo.",
                "retryHint": "Place the card on a plain, contrasting background and make sure all four corners are in frame.",
            },
        )

    q = measure_quality(det)

    if det.card_area_frac < dcfg.min_card_area_frac:
        rej = {
            "reason": "card_too_small",
            "userMessage": "The card is too small in the frame to measure accurately.",
            "retryHint": "Move closer so the card fills most of the frame.",
        }
    elif det.source_short_side_px < dcfg.hard_min_source_width_px:
        rej = {
            "reason": "resolution_too_low",
            "userMessage": "The photo doesn't have enough detail for a reliable measurement.",
            "retryHint": "Use a higher camera resolution or move closer to the card.",
        }
    elif q.blur_score < qcfg.min_blur_score * (
        qcfg.low_detail_blur_factor if q.low_detail else 1.0
    ):
        rej = {
            "reason": "too_blurry",
            "userMessage": "This photo is too blurry to measure.",
            "retryHint": "Hold the phone steady, tap to focus on the card, and re-shoot.",
        }
    elif q.glare_pct > qcfg.max_glare_pct:
        rej = {
            "reason": "too_much_glare",
            "userMessage": f"Glare is hiding {q.glare_pct:.0f}% of the card surface.",
            "retryHint": _glare_hint(q.glare_regions),
        }
    else:
        rej = None

    return GateResult(quality=q, rejection=rej)
