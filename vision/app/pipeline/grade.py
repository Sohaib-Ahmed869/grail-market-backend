"""Heuristic condition analysis and overall grade estimate (v0).

Corners, edges, and surface are scored with classical CV heuristics — no
trained models yet — so every sub-grade carries an explicit confidence and
the overall grade is reported as a BAND whose width grows as confidence
drops. Centering converts the measured ratios through the PSA centering
scale. This is honest scaffolding: the numbers get sharper as trained
analyzers replace heuristics, but the shape of the output (sub-grades +
confidence + band) is the product's permanent contract.
"""

from dataclasses import dataclass

import cv2
import numpy as np

from .centering import CenteringResult
from .config import CONFIG


@dataclass
class Subgrade:
    value: float
    confidence: float


@dataclass
class GradeResult:
    overall: float
    band_low: float
    band_high: float
    centering: Subgrade | None
    corners: Subgrade | None
    edges: Subgrade | None
    surface: Subgrade
    findings: dict
    notes: list


# PSA centering scale: worst-side percentage -> grade (front)
_PSA_CENTERING = [(60, 10.0), (65, 9.0), (70, 8.0), (75, 7.0), (80, 6.0), (85, 5.0), (90, 4.0)]


def _centering_grade(cen: CenteringResult) -> Subgrade | None:
    if not cen.measurable:
        return None
    worst = max(cen.lr, 100 - cen.lr, cen.tb, 100 - cen.tb)
    grade = 10.0
    prev_limit = 55.0
    for limit, g in _PSA_CENTERING:
        if worst <= limit:
            # interpolate within the bracket for a half-point-ish scale
            upper_g = g + 1.0 if g < 10 else 10.0
            frac = (worst - prev_limit) / (limit - prev_limit) if limit > prev_limit else 1.0
            grade = round((upper_g - frac * (upper_g - g)) * 2) / 2
            break
        prev_limit = limit
    else:
        grade = 3.0
    return Subgrade(value=min(grade, 10.0), confidence=cen.confidence)


def _wear_mask(stock: np.ndarray, med: np.ndarray) -> np.ndarray:
    """Damage has a specific optical signature: whitening is PALE-BRIGHT
    (paper showing through ink — brighter than stock and desaturated), and
    dings expose MUCH DARKER cardboard. Colored deviation — foil sheen,
    holo shimmer, artwork — is neither, and must not count as wear
    (black-border foil cards were being butchered by exactly that)."""
    dev = np.linalg.norm(stock - med, axis=1)
    v = stock.mean(axis=1)
    med_v = float(med.mean())
    sat = stock.max(axis=1) - stock.min(axis=1)
    pale_bright = (v > med_v + 50) & (sat < 80)
    much_darker = v < med_v - 50
    return (dev > 60) & (pale_bright | much_darker)


CORNER_RADIUS = 38  # design corner radius on the 750x1050 canonical crop (~3.2mm)
CORNER_RADIUS_SLACK = 9  # uncertainty annulus around the design arc, excluded


def _corner_mask(n: int) -> np.ndarray:
    """True on a thin ring of card stock just inside the design corner arc
    of an n x n top-left corner crop. Cards have rounded corners by design,
    so beyond the arc is legitimate background; deeper inside the border
    there can be printed text (copyright lines). The rim ring is where
    physical corner wear actually lives, and only stock belongs there."""
    yy, xx = np.mgrid[:n, :n]
    dist = np.sqrt((xx - CORNER_RADIUS) ** 2 + (yy - CORNER_RADIUS) ** 2)
    quarter = (xx < CORNER_RADIUS) & (yy < CORNER_RADIUS)
    ring = (
        quarter
        & (dist >= CORNER_RADIUS - 14)
        & (dist <= CORNER_RADIUS - CORNER_RADIUS_SLACK + 4)
    )
    return ring


# background may intrude this deep (px from the corner point) before it
# counts as wear — covers normal factory corner rounding plus warp slack
CORNER_BG_BASELINE_PX = 13.0


def _corner_grade(warped: np.ndarray, bg_color=None) -> tuple:
    """Two complementary signals per corner; the geometric one works on ANY
    design (full-art included):
    1. GEOMETRY — a worn/rounded/dinged corner lets the BACKGROUND (its true
       color, sampled around the card in the original photo) intrude deeper
       past the corner point than factory rounding allows.
    2. STOCK WEAR — whitening / exposed cardboard against uniform border
       stock (only when the corner ring actually is uniform stock).
    Returns (Subgrade, per-corner detail list for the overlay)."""
    h, w = warped.shape[:2]
    n = 52
    m = 4  # skip the warp seam: the quad sits a pixel or two outside the card
    ring = _corner_mask(n)
    yy, xx = np.mgrid[:n, :n]
    dist_from_corner = np.sqrt(xx.astype(np.float32) ** 2 + yy.astype(np.float32) ** 2)
    crops = [
        ("TL", warped[m : m + n, m : m + n]),
        ("TR", warped[m : m + n, w - m - n : w - m][:, ::-1]),
        ("BL", warped[h - m - n : h - m, m : m + n][::-1, :]),
        ("BR", warped[h - m - n : h - m, w - m - n : w - m][::-1, ::-1]),
    ]
    per_corner = []  # (name, geo_score, wear_score)
    for name, crop in crops:
        f = crop.astype(np.float32)

        stock = f[ring]
        med = np.median(stock.reshape(-1, 3), axis=0)

        # geometric: how deep does true-background color reach past the
        # corner point? Only counts background CONNECTED to the corner (dark
        # print text that happens to match the background is an island), and
        # only when background is distinguishable from the card stock at all.
        geo_score = None
        if bg_color is not None:
            bg_ref = np.asarray(bg_color, dtype=np.float32)
            if float(np.linalg.norm(bg_ref - med)) > 60.0:
                bg_mask = (np.linalg.norm(f - bg_ref, axis=2) < 48.0).astype(np.uint8)
                cnt, labels = cv2.connectedComponents(bg_mask, connectivity=8)
                corner_labels = set(
                    labels[(dist_from_corner < CORNER_BG_BASELINE_PX) & (bg_mask > 0)].tolist()
                ) - {0}
                if corner_labels:
                    connected = np.isin(labels, list(corner_labels))
                    depth = float(np.percentile(dist_from_corner[connected], 95))
                    geo_score = max(
                        1.0, 10.0 - 0.35 * max(0.0, depth - CORNER_BG_BASELINE_PX)
                    )
                else:
                    geo_score = 10.0  # no background reaches the corner at all

        # stock wear on the rim ring (uniform stock only)
        dev = np.linalg.norm(stock - med, axis=1)
        uniform = float((dev < 60).mean())
        wear_score = None
        # wear is only judged against clearly uniform stock — busy art rings
        # produced phantom 1.0s on full-art designs below this bar
        if uniform >= 0.7:
            wear_frac = float(_wear_mask(stock, med).mean())
            wear_score = max(1.0, 10.0 - wear_frac * 40.0)

        per_corner.append((name, geo_score, wear_score))

    # all four corners geo-flooring identically is a detection artifact (the
    # quad included a margin of background around the card, e.g. inside a
    # slab) — real wear is asymmetric. Discard geometry in that case.
    geo_vals = [g for _, g, _ in per_corner if g is not None]
    if len(geo_vals) == 4 and max(geo_vals) <= 2.0:
        per_corner = [(nm, None, ws) for nm, _, ws in per_corner]

    details = []
    scores = []
    for name, geo_score, wear_score in per_corner:
        candidates = [s for s in (geo_score, wear_score) if s is not None]
        corner_score = min(candidates) if candidates else None
        if corner_score is not None:
            scores.append(corner_score)
            details.append({"corner": name, "score": round(corner_score * 2) / 2})

    if not scores:
        return None, details
    value = round(min(scores) * 2) / 2
    return Subgrade(value=value, confidence=0.4), details


def _edge_grade(warped: np.ndarray) -> Subgrade:
    """Whitening/chipping along the four outer strips."""
    h, w = warped.shape[:2]
    t, m, s = 6, 80, 4  # strip thickness; corner margin; warp-seam skip
    strips = [
        warped[s : s + t, m : w - m],
        warped[h - s - t : h - s, m : w - m],
        warped[m : h - m, s : s + t],
        warped[m : h - m, w - s - t : w - s],
    ]
    scores = []
    for strip in strips:
        # evaluate in 8 segments, each against its own median, so gradient /
        # holographic borders don't read as damage — only local nicks do
        length = max(strip.shape[0], strip.shape[1])
        axis = 0 if strip.shape[0] >= strip.shape[1] else 1
        seg_len = length // 8
        whitening = []
        for k in range(8):
            seg = (
                strip[k * seg_len : (k + 1) * seg_len]
                if axis == 0
                else strip[:, k * seg_len : (k + 1) * seg_len]
            )
            f = seg.astype(np.float32).reshape(-1, 3)
            if f.shape[0] == 0:
                continue
            med = np.median(f, axis=0)
            whitening.append(float(_wear_mask(f, med).mean()))
        worst = max(whitening) if whitening else 0.0
        # a strip where several segments deviate isn't damage, it's artwork
        # reaching the card edge (full-bleed) — no stock to judge. Likewise a
        # single segment deviating MASSIVELY is design (foil sheen, art), not
        # a nick — real edge nicks disturb a minor fraction of a segment.
        busy = sum(1 for x in whitening if x > 0.3)
        if busy >= 3 or worst > 0.5:
            return None
        scores.append(max(1.0, 10.0 - worst * 60.0))
    return Subgrade(value=round(min(scores) * 2) / 2, confidence=0.5)


def _surface_grade(warped: np.ndarray) -> tuple:
    """Thin bright streaks (scratches/print lines) in the inner face, found by
    top-hat filtering against the card's own texture statistics. Returns the
    sub-grade plus concrete findings (cluster boxes in warped coordinates)."""
    h, w = warped.shape[:2]
    inset_h, inset_w = int(0.12 * h), int(0.12 * w)
    face = warped[inset_h : h - inset_h, inset_w : w - inset_w]
    gray = cv2.cvtColor(face, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(face, cv2.COLOR_BGR2HSV)

    # scratches are line-like, so probe multiple orientations; long thin
    # kernels respond to scratch lines much more than to art texture
    resp = None
    for k in [(21, 1), (1, 21), (9, 9)]:
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, k)
        r = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, kernel).astype(np.float32)
        resp = r if resp is None else np.maximum(resp, r)
    # sigma-based thresholds explode on busy art (they can exceed the max
    # response); cap with a percentile so strong lines always stay detectable
    thresh = max(40.0, min(float(resp.mean() + 3 * resp.std()), float(np.percentile(resp, 99.2))))

    # a scratch exposes pale paper through ink: desaturated, bright, and —
    # crucially — brighter than its LOCAL surroundings. Intentional white art
    # (outlines, speech bubbles) sits inside white regions and fails that test.
    v = hsv[..., 2]
    local_v = cv2.medianBlur(v, 15)
    brighter_than_local = v.astype(np.int16) - local_v.astype(np.int16) > 35
    pale = (hsv[..., 1] <= 80) & (v >= 150)
    mask = ((resp > thresh) & pale & brighter_than_local).astype(np.uint8)
    defect_frac = float(mask.mean())

    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    clusters = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < 30:  # ignore specks below scratch scale
            continue
        clusters.append(
            {
                "x": float((stats[i, cv2.CC_STAT_LEFT] + inset_w) / w),
                "y": float((stats[i, cv2.CC_STAT_TOP] + inset_h) / h),
                "w": float(stats[i, cv2.CC_STAT_WIDTH] / w),
                "h": float(stats[i, cv2.CC_STAT_HEIGHT] / h),
                "areaPx": area,
            }
        )
    clusters.sort(key=lambda c: -c["areaPx"])

    # detected marks cap the grade regardless of how few pixels they cover —
    # a visible scratch is a visible scratch
    count = len(clusters)
    cap = 10.0
    for threshold, capped in [(1, 9.0), (2, 8.5), (4, 7.5), (8, 6.5), (15, 5.5)]:
        if count >= threshold:
            cap = capped
    value = max(1.0, min(10.0 - defect_frac * 400.0, cap))
    findings = {
        "scratchesDetected": len(clusters) > 0,
        "clusterCount": len(clusters),
        "clusters": clusters[:8],
        "defectFrac": round(defect_frac, 5),
    }
    return Subgrade(value=round(value * 2) / 2, confidence=0.35), findings


def compute_grade(
    warped: np.ndarray,
    cen: CenteringResult,
    low_detail: bool = False,
    bg_color=None,
) -> GradeResult:
    centering = _centering_grade(cen)
    corners, corner_details = _corner_grade(warped, bg_color=bg_color)
    edges = _edge_grade(warped)
    surface, findings = _surface_grade(warped)
    findings["corners"] = corner_details

    # strong illumination gradient (card shot standing / under side-light)
    # makes shadow read as damage — edge wear claims are not trustworthy
    # under those conditions. Corner GEOMETRY survives it (boundary contrast
    # persists in shadow), so corners keep their score at lower confidence.
    # Measured on the BORDER strips: border stock is the same color all
    # around, so brightness asymmetry there is lighting, not artwork.
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)
    h, w = gray.shape
    s, t, m = 4, 12, 80
    top_strip = float(gray[s : s + t, m : w - m].mean())
    bottom_strip = float(gray[h - s - t : h - s, m : w - m].mean())
    left_strip = float(gray[m : h - m, s : s + t].mean())
    right_strip = float(gray[m : h - m, w - s - t : w - s].mean())
    uneven_light = max(abs(top_strip - bottom_strip), abs(left_strip - right_strip)) > 22.0
    if uneven_light:
        edges = None
        if corners is not None:
            corners = Subgrade(value=corners.value, confidence=0.25)

    # full-art / foil designs (nothing assessable but surface) produce many
    # false surface positives from holo texture and pale art — soften the
    # scratch caps and say so, rather than tanking the grade on design
    full_art = corners is None and edges is None and centering is None
    if full_art and surface.value < 7.0:
        surface = Subgrade(value=7.0, confidence=0.2)

    notes = ["Corner, edge, and surface scores are heuristic (v0) — no trained models yet."]
    if uneven_light:
        notes.append(
            "Uneven lighting across the card (angled shot or side-light): edge wear can't "
            "be separated from shadow, so edges aren't assessed and corner confidence is "
            "reduced. Shoot the card flat under even light for a full assessment."
        )
    if full_art:
        notes.append(
            "Full-art / foil design: surface findings on holo textures are less reliable — "
            "treat the surface score as indicative only."
        )
    if low_detail:
        # small photo: every claim is weaker; the band widens accordingly
        for s in (centering, corners, edges, surface):
            if s is not None:
                s.confidence *= 0.6
        notes.append(
            "Low-detail photo: the card is small in this image, so confidence is reduced "
            "and the grade band is wider. A closer shot will tighten it."
        )
    parts = [(surface, 0.25)]
    for sub, weight, label in [
        (corners, 0.25, "Corners"),
        (edges, 0.20, "Edges"),
        (centering, 0.30, "Centering"),
    ]:
        if sub is not None:
            parts.append((sub, weight))
        else:
            notes.append(f"{label} not assessable on this card; excluded from the overall grade.")

    total_w = sum(wt for _, wt in parts)
    weighted = sum(s.value * wt for s, wt in parts) / total_w
    min_sub = min(s.value for s, _ in parts)
    overall = round(min(weighted, min_sub + 1.5) * 2) / 2

    conf = sum(s.confidence * wt for s, wt in parts) / total_w
    half_width = float(np.clip(0.5 + (1.0 - conf) * 1.5, 0.5, 2.0))
    band_low = max(1.0, round((overall - half_width) * 2) / 2)
    band_high = min(10.0, round((overall + half_width) * 2) / 2)

    return GradeResult(
        overall=overall,
        band_low=band_low,
        band_high=band_high,
        centering=centering,
        corners=corners,
        edges=edges,
        surface=surface,
        findings=findings,
        notes=notes,
    )
