"""Pipeline orchestration: detect -> gate -> measure -> assemble the
VisionAnalyzeResponse (camelCase, mirrors packages/shared)."""

import base64
from dataclasses import asdict

import cv2
import numpy as np

from .authenticity import digital_source_check
from .detect import detect_card
from .identify import read_card_text
from .quality import run_gate


def _b64_png(image: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("png encode failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")



def _room_for_a_label(card_fill: float | None, headroom: float | None) -> bool:
    """Might this photo contain a grading label we have not read yet?

    Getting this wrong in the FALSE direction is expensive and silent: the
    label is never read, the card is reported as raw, and a graded card is
    quoted at its ungraded price — an order of magnitude out, with nothing on
    screen suggesting anything went wrong. Getting it wrong in the TRUE
    direction costs one extra OCR pass on a photo that turns out to have no
    label. Those are not remotely the same price, so this leans generous.

    Fill alone was the whole test, at < 0.65, and it is a weak signal: a CGC
    8.5 Armored Mewtwo photographed close came in at 0.6606 and was priced as
    a raw card, missing by one point of a percent.

    Headroom is the better signal and the reason is geometric. A slab's label
    sits ABOVE the card, so the detected card cannot start at the top of the
    frame; a raw card photographed to fill the frame can. Either signal is
    enough on its own.
    """
    if card_fill is not None and card_fill < 0.80:
        return True
    # the card starts far enough down the frame that something sits above it
    if headroom is not None and headroom > 0.06:
        return True
    return False


def _quality_dict(q) -> dict:
    return {
        "blurScore": q.blur_score,
        "glarePct": q.glare_pct,
        "glareRegions": q.glare_regions,
        "cardAreaPct": q.card_area_pct,
        "resolutionOk": q.resolution_ok,
        "lowDetail": q.low_detail,
    }


def run_pipeline(
    image: np.ndarray, include_images: bool = True, read_text: bool = True
) -> dict:
    det = detect_card(image)
    gate = run_gate(det, image.shape)

    # identification hints need far less resolution than grading, so a
    # rejected scan can still tell the user which card we saw
    ocr = read_card_text(det.warped) if (det is not None and read_text) else None

    # A grading label sits OUTSIDE the card, so it is cropped away by the card
    # detection and can never be read from the warped card alone. The retry on
    # the full image existed, but was gated on the photo being REJECTED or
    # low-detail — which is exactly backwards. A good, sharp photo of a slab
    # passes the gate cleanly, so the retry never fired and the label went
    # unread: no slab meant no answer-key identification (a Legendary
    # Collection Charizard resolved to a Dragon Frontiers Gold Star) and no
    # slab meant we graded a card someone had already graded.
    #
    # The real signal is what the comment always claimed: how much of the frame
    # the card occupies. A slab photo leaves the card at a fraction of the
    # frame because the case and its label surround it; a raw-card photo fills
    # it. Below the threshold there is room for a label, so it is worth a look.
    card_fill = None
    headroom = None
    if det is not None and getattr(det, "quad", None) is not None:
        frame_h, frame_w = image.shape[0], image.shape[1]
        frame_area = float(frame_h * frame_w)
        if frame_area > 0:
            card_fill = cv2.contourArea(det.quad.astype(np.float32)) / frame_area
        if frame_h > 0:
            # how far down the frame the card starts, as a fraction of height
            headroom = float(det.quad[:, 1].min()) / float(frame_h)
    room_for_a_label = _room_for_a_label(card_fill, headroom)

    if (
        ocr is not None
        and not ocr.get("slab")
        and (gate.rejection is not None or gate.quality.low_detail or room_for_a_label)
    ):
        full_reading = read_card_text(image)
        if full_reading.get("slab"):
            ocr = {**ocr, "slab": full_reading["slab"]}
            # the label also carries the collector number and set, which the
            # card face may not have given us
            for k in ("collectorNumber", "setCode"):
                if not ocr.get(k) and full_reading.get(k):
                    ocr = {**ocr, k: full_reading[k]}

    if gate.rejection is not None:
        # A rejected photo used to still return a "provisional" grade. We no
        # longer grade at all, so there is nothing provisional to offer — the
        # rejection and its retry hint are the whole answer.
        return {
            "ok": False,
            "quality": _quality_dict(gate.quality) if det is not None else None,
            "rejection": gate.rejection,
            "measurement": None,
            "grade": None,
            "authenticity": digital_source_check(det.warped) if det is not None else None,
            "ocr": ocr,
            "warpedImageB64": _b64_png(det.warped) if include_images and det else None,
            "overlayImageB64": None,
        }

    slab_read = (ocr or {}).get("slab")

    # A slab photo that is too degraded to read is worse than no answer. We no
    # longer grade these cards, so blur and glare do not cost us a grade — they
    # cost us the LABEL, and an unread label drops the card to fuzzy name
    # matching, which is what put a Legendary Collection Charizard in Dragon
    # Frontiers. If the photo looks like a slab but no label came back, decline
    # and ask for a better one rather than guessing at four figures.
    if not slab_read and room_for_a_label and (
        gate.quality.glare_pct >= 2.0 or gate.quality.blur_score < 80.0
    ):
        return {
            "ok": False,
            "quality": _quality_dict(gate.quality),
            "rejection": {
                "reason": "label_unreadable",
                "userMessage": (
                    "This looks like a graded card, but the label on the holder "
                    "couldn't be read."
                ),
                "retryHint": (
                    "Shoot the slab flat-on with the whole label in frame, and tilt "
                    "it slightly away from the light so the plastic doesn't glare."
                ),
            },
            "measurement": None,
            "grade": None,
            "authenticity": None,
            "ocr": ocr,
            "warpedImageB64": None,
            "overlayImageB64": None,
        }

    # We no longer issue a condition grade for ANY card, slabbed or raw.
    # For a slab it was second-guessing a professional; for a raw card the
    # heuristics were producing a 2.5 off 69 "surface marks" on a clean card
    # and then multiplying the market price by 0.25, turning an $84 card into
    # $21. Detection quality is not good enough to move money, so it does not.
    # We identify the card, read any grading label, and price it.
    #
    # compute_grade and measure_centering are deliberately still in the tree,
    # still tested, and no longer called from anywhere. This used to be an
    # `if True:` with the old grading path left unreachable underneath it,
    # which read as live code to everyone including the people costing it.
    return {
        "ok": True,
        "quality": _quality_dict(gate.quality),
        "rejection": None,
        "measurement": None,
        "grade": None,
        "gradingSkipped": "slabbed",
        "authenticity": digital_source_check(det.warped),
        "ocr": ocr,
        "warpedImageB64": _b64_png(det.warped) if include_images else None,
        "overlayImageB64": None,
    }
