"""Card detection and perspective normalisation.

Finds the card's outer quad in a photo and warps it to the canonical
750x1050 portrait crop that every downstream module consumes.
"""

from dataclasses import dataclass

import cv2
import numpy as np

from .config import CONFIG


@dataclass
class Detection:
    warped: np.ndarray  # canonical portrait crop, BGR
    quad: np.ndarray  # 4x2 float32 source corners (tl, tr, br, bl)
    card_area_frac: float  # quad area / image area
    source_short_side_px: float  # card's short side length in source pixels
    bg_color: tuple | None = (0, 0, 0)  # median BGR around the card; None = no background (full-frame)
    full_frame: bool = False  # the image itself is the card (cropped scan/render)


def _order_corners(pts: np.ndarray) -> np.ndarray:
    """Return corners ordered tl, tr, br, bl."""
    pts = pts.reshape(4, 2).astype(np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()  # y - x
    return np.array(
        [pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]],
        dtype=np.float32,
    )


def _candidate_masks(blur: np.ndarray):
    edges = cv2.Canny(blur, 50, 150)
    yield cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
    # fallback for soft/blurry frames: a light card on a darker background
    # still separates cleanly under Otsu even when Canny finds nothing
    _, otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    yield otsu


def _find_quad(image: np.ndarray) -> np.ndarray | None:
    cfg = CONFIG.detect
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    for mask in _candidate_masks(blur):
        quad = _quad_from_mask(image, mask)
        if quad is not None:
            return quad
    return None


def _quad_from_mask(image: np.ndarray, mask: np.ndarray) -> np.ndarray | None:
    cfg = CONFIG.detect
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = float(image.shape[0] * image.shape[1])

    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:10]:
        if cv2.contourArea(contour) < cfg.min_contour_area_frac * img_area:
            return None
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            quad = _order_corners(approx)
        else:
            # non-quad outline (rounded corners, slight occlusion): fit a box
            quad = _order_corners(cv2.boxPoints(cv2.minAreaRect(contour)))

        w = (np.linalg.norm(quad[1] - quad[0]) + np.linalg.norm(quad[2] - quad[3])) / 2
        h = (np.linalg.norm(quad[3] - quad[0]) + np.linalg.norm(quad[2] - quad[1])) / 2
        short, long_ = min(w, h), max(w, h)
        if long_ == 0:
            continue
        area_frac = cv2.contourArea(quad) / img_area
        if area_frac > cfg.max_card_area_frac:
            continue
        if cfg.aspect_min <= short / long_ <= cfg.aspect_max:
            return quad
    return None


def _full_frame_detection(image: np.ndarray) -> Detection:
    """The image IS the card (a cropped scan or render): no outer boundary
    exists to detect, so the frame corners are the card corners."""
    cfg = CONFIG.detect
    ih, iw = image.shape[:2]
    warped = cv2.resize(image, (cfg.canonical_w, cfg.canonical_h), interpolation=cv2.INTER_CUBIC)
    quad = np.array([[0, 0], [iw - 1, 0], [iw - 1, ih - 1], [0, ih - 1]], dtype=np.float32)
    return Detection(
        warped=warped,
        quad=quad,
        card_area_frac=1.0,
        source_short_side_px=float(min(iw, ih)),
        bg_color=None,
        full_frame=True,
    )


def _image_is_card_shaped(image: np.ndarray) -> bool:
    ih, iw = image.shape[:2]
    short, long_ = min(iw, ih), max(iw, ih)
    return 0.63 <= short / long_ <= 0.85


def detect_card(image: np.ndarray) -> Detection | None:
    cfg = CONFIG.detect
    quad = _find_quad(image)
    if quad is None:
        # no boundary found — if the image itself is card-proportioned AND has
        # actual content, it IS the card (renders, tightly cropped scans)
        if _image_is_card_shaped(image) and float(image.std()) > 25.0:
            return _full_frame_detection(image)
        return None

    w = (np.linalg.norm(quad[1] - quad[0]) + np.linalg.norm(quad[2] - quad[3])) / 2
    h = (np.linalg.norm(quad[3] - quad[0]) + np.linalg.norm(quad[2] - quad[1])) / 2

    dst = np.array(
        [
            [0, 0],
            [cfg.canonical_w - 1, 0],
            [cfg.canonical_w - 1, cfg.canonical_h - 1],
            [0, cfg.canonical_h - 1],
        ],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(quad, dst)
    warped = cv2.warpPerspective(image, matrix, (cfg.canonical_w, cfg.canonical_h))
    if w > h:  # landscape shot of a portrait card
        warped = cv2.rotate(warped, cv2.ROTATE_90_CLOCKWISE)
        warped = cv2.resize(warped, (cfg.canonical_w, cfg.canonical_h))

    area_frac = cv2.contourArea(quad.astype(np.float32)) / float(
        image.shape[0] * image.shape[1]
    )

    # sample the true background: a band just outside the quad
    ih, iw = image.shape[:2]
    inner = np.zeros((ih, iw), np.uint8)
    cv2.fillPoly(inner, [quad.astype(np.int32)], 255)
    band = cv2.dilate(inner, np.ones((25, 25), np.uint8)) & ~inner
    bg_px = image[band > 0]
    bg_color = tuple(float(v) for v in np.median(bg_px.reshape(-1, 3), axis=0)) if bg_px.size else None

    # a BUSY band around a smallish quad in a card-shaped image means we
    # latched onto an inner design frame of a full-frame card — the "band"
    # is artwork, not background. The whole image is the card.
    if bg_px.size:
        band_std = float(bg_px.reshape(-1, 3).std(axis=0).mean())
        if area_frac < 0.85 and band_std > 45.0 and _image_is_card_shaped(image):
            return _full_frame_detection(image)

    return Detection(
        warped=warped,
        quad=quad,
        card_area_frac=float(area_frac),
        source_short_side_px=float(min(w, h)),
        bg_color=bg_color,
    )
