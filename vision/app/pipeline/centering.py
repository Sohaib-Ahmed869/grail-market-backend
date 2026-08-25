"""Centering as a measurement, not a model opinion.

On the warped canonical crop the card's outer edge IS the image edge, so
centering reduces to locating the inner print border on each side and doing
pixel arithmetic.

The border is found with a COLOR WALK rather than a gradient peak: sample the
border's color in a thin ring just inside the card edge, then walk inward
until pixels stop matching that color (sustained across the band). This is
era-independent — a thick yellow vintage border and a thin silver modern
border behave identically — and it degrades honestly: a borderless/full-art
card has no uniform ring color, which marks the side unmeasurable instead of
producing a fabricated ratio.
"""

from dataclasses import dataclass

import cv2
import numpy as np

from .config import CONFIG


@dataclass
class SideResult:
    offset_px: int  # inner border distance from the card edge
    quality: float  # contrast-past-border * ring uniformity (0 = no border)


@dataclass
class CenteringResult:
    lr: float  # left share in percent (52.0 means 52/48)
    tb: float  # top share in percent
    measurable: bool
    confidence: float
    passes_psa10: bool
    passes_psa9: bool
    offsets: dict  # {left, right, top, bottom} px on the canonical crop
    overlay: np.ndarray  # annotated warped image


def _scan_from_left(img: np.ndarray) -> SideResult:
    """Color-walk the border as seen from the LEFT edge of `img` (BGR)."""
    cfg = CONFIG.centering
    h, w = img.shape[:2]
    band = img[int(cfg.band_lo * h) : int(cfg.band_hi * h), : int(cfg.search_frac * w)]
    band = band.astype(np.float32)

    # sample the border color a bit further in — the outermost pixels carry
    # warp seam, edge shadow, and perspective vignette on real photos
    ring = band[:, 5:13].reshape(-1, 3)
    ref = np.median(ring, axis=0)
    ring_uniform = float(np.mean(np.linalg.norm(ring - ref, axis=1) < cfg.color_tol))

    dist = np.linalg.norm(band - ref, axis=2)  # (rows, cols)
    dev = (dist > cfg.color_tol).mean(axis=0)  # per-column deviation fraction

    min_off = max(3, int(cfg.min_offset_frac * w))
    offset = None
    line_offset = None
    run = 0
    for i in range(min_off, band.shape[1]):
        if dev[i] > cfg.dev_frac:
            run += 1
            # a strong thin frame line (comic-style borders) is also a valid
            # border boundary even if the interior returns to border-ish color
            if line_offset is None and run >= 2 and dev[i] > 0.75:
                line_offset = i - run + 1
            if run >= cfg.sustain_px:
                offset = i - cfg.sustain_px + 1
                break
        else:
            run = 0
    if offset is None:
        offset = line_offset

    if offset is None or ring_uniform < cfg.ring_uniform_min:
        fallback = int(np.argmax(dev[min_off:])) + min_off if len(dev) > min_off else min_off
        return SideResult(offset_px=offset or fallback, quality=0.0)

    past = dist[:, offset + 2 : offset + 12]
    contrast = float(past.mean() / (cfg.color_tol + 1e-6)) if past.size else 0.0
    line = dist[:, offset : offset + 2]
    line_contrast = float(line.mean() / (cfg.color_tol + 1e-6)) if line.size else 0.0
    quality = max(contrast, line_contrast) * ring_uniform
    return SideResult(offset_px=offset, quality=quality)


def measure_centering(warped: np.ndarray) -> CenteringResult:
    cfg = CONFIG.centering
    h, w = warped.shape[:2]

    left = _scan_from_left(warped)
    right = _scan_from_left(warped[:, ::-1])
    top = _scan_from_left(warped.transpose(1, 0, 2))
    bottom = _scan_from_left(warped.transpose(1, 0, 2)[:, ::-1])

    sides = [left, right, top, bottom]
    worst_quality = min(s.quality for s in sides)
    measurable = worst_quality >= cfg.min_quality
    confidence = float(
        np.clip(
            (worst_quality - cfg.conf_quality_lo)
            / (cfg.conf_quality_hi - cfg.conf_quality_lo),
            0.0,
            1.0,
        )
    )

    lr = 100.0 * left.offset_px / max(left.offset_px + right.offset_px, 1)
    tb = 100.0 * top.offset_px / max(top.offset_px + bottom.offset_px, 1)

    worst_lr = max(lr, 100 - lr)
    worst_tb = max(tb, 100 - tb)
    passes_psa10 = measurable and worst_lr <= cfg.psa10_max and worst_tb <= cfg.psa10_max
    passes_psa9 = measurable and worst_lr <= cfg.psa9_max and worst_tb <= cfg.psa9_max

    overlay = warped.copy()
    if measurable:
        color = (200, 220, 40)  # cyan-ish measurement lines
        dot = (255, 240, 90)
        x0, x1 = left.offset_px, w - right.offset_px
        y0, y1 = top.offset_px, h - bottom.offset_px
        cv2.line(overlay, (x0, 0), (x0, h), color, 2)
        cv2.line(overlay, (x1, 0), (x1, h), color, 2)
        cv2.line(overlay, (0, y0), (w, y0), color, 2)
        cv2.line(overlay, (0, y1), (w, y1), color, 2)
        # measurement points: inner-frame corners, edge midpoints, center
        mx, my = (x0 + x1) // 2, (y0 + y1) // 2
        for px, py in [
            (x0, y0), (x1, y0), (x0, y1), (x1, y1),  # frame corners
            (mx, y0), (mx, y1), (x0, my), (x1, my),  # edge midpoints
        ]:
            cv2.circle(overlay, (px, py), 8, (30, 30, 30), -1)
            cv2.circle(overlay, (px, py), 6, dot, -1)
        cv2.circle(overlay, (mx, my), 9, (30, 30, 30), -1)
        cv2.circle(overlay, (mx, my), 7, (90, 220, 90), -1)  # center dot
        label = f"L/R {lr:.0f}/{100 - lr:.0f}  T/B {tb:.0f}/{100 - tb:.0f}"
        cv2.putText(
            overlay, label, (20, h - 25), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 4
        )
        cv2.putText(
            overlay, label, (20, h - 25), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2
        )

    return CenteringResult(
        lr=float(lr),
        tb=float(tb),
        measurable=measurable,
        confidence=confidence,
        passes_psa10=passes_psa10,
        passes_psa9=passes_psa9,
        offsets={
            "left": left.offset_px,
            "right": right.offset_px,
            "top": top.offset_px,
            "bottom": bottom.offset_px,
        },
        overlay=overlay,
    )
