"""Telling one printing of a card from another.

A collector number names a CARD. The artwork names the PRINTING, and one
number can be five products a thousand times apart in price: OP13-118
Monkey.D.Luffy is US$13 as the base print and US$19,999 as the Red Super
Alternate Art. Picking the wrong one is not a rounding error.

dHash was the whole of this test's subject once, and it is right about the
card while being blind to the thing that separates its printings — it works
on an 8x9 greyscale thumbnail, and the expensive Luffy is distinguished by
being red. These pin the pair that replaced it: structure, which survives bad
photography, and hue, which survives similar layouts.

The photographs are simulated on purpose. A fixed seed means the numbers below
move only when the matcher moves, and the degradations are the ones a phone in
a living room actually produces: a steep angle, a specular blob from the
ceiling light, a crop that misses the border, and a warm bulb.
"""

import glob
import os

import cv2
import numpy as np
import pytest

from app.pipeline.match import (
    combined_similarity,
    dhash,
    hue_signature,
    hue_similarity,
    similarity,
)

CARDS = os.path.join(os.path.dirname(__file__), "..", "..", "..", "demo-cards")

# The threshold src/scans/printingpicker.ts requires before it will act on the
# picture. A margin under this is reported as "too close to call" and the
# caller falls back to catalogue order — which is the base card.
MIN_MARGIN = 0.05


def _load(path):
    return cv2.resize(cv2.imread(path), (420, 586), interpolation=cv2.INTER_AREA)


def _photograph(img, rng):
    """A phone photo of the card: angle, glare, crop error, warm light."""
    h, w = img.shape[:2]
    jitter = 40
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32(
        [
            [rng.uniform(0, jitter), rng.uniform(0, jitter)],
            [w - rng.uniform(0, jitter), rng.uniform(0, jitter)],
            [w - rng.uniform(0, jitter), h - rng.uniform(0, jitter)],
            [rng.uniform(0, jitter), h - rng.uniform(0, jitter)],
        ]
    )
    out = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w, h))

    crop = int(rng.uniform(6, 26))
    out = cv2.resize(out[crop : h - crop, crop : w - crop], (w, h), interpolation=cv2.INTER_AREA)

    glare = np.zeros((h, w), np.float32)
    cv2.circle(
        glare,
        (int(rng.uniform(0.2, 0.8) * w), int(rng.uniform(0.15, 0.6) * h)),
        int(rng.uniform(70, 150)),
        1.0,
        -1,
    )
    glare = cv2.GaussianBlur(glare, (0, 0), 55)
    out = np.clip(out.astype(np.float32) + glare[..., None] * rng.uniform(70, 150), 0, 255)

    out = np.clip(out * np.array([0.88, 0.98, 1.12]), 0, 255).astype(np.uint8)
    out = cv2.convertScaleAbs(out, alpha=rng.uniform(0.8, 1.2), beta=rng.uniform(-25, 25))
    return np.clip(out + rng.normal(0, 7, out.shape), 0, 255).astype(np.uint8)


def _printings(folder):
    files = sorted(glob.glob(os.path.join(CARDS, folder, "*.jpg")))
    if len(files) < 3:
        pytest.skip(f"{folder}: demo-cards not present")
    return [os.path.basename(f).split("-USD")[0] for f in files], [_load(f) for f in files]


def _rank(shot, refs):
    """(index of the best match, how far it cleared the runner-up)."""
    struct = [similarity(dhash(shot), dhash(r)) for r in refs]
    colour = [hue_similarity(hue_signature(shot), hue_signature(r)) for r in refs]
    scores = [combined_similarity(s, c) for s, c in zip(struct, colour)]
    order = np.argsort(scores)[::-1]
    return int(order[0]), scores[order[0]] - scores[order[1]]


FOLDERS = [
    "op13-118-luffy",
    "op17-062-kaido",
    "op17-022-shanks",
    "op17-005-newgate",
    "op17-079-luffy",
]


@pytest.mark.parametrize("folder", FOLDERS)
def test_a_photograph_prefers_its_own_printing(folder):
    names, refs = _printings(folder)
    rng = np.random.default_rng(11)
    for i, name in enumerate(names):
        for _ in range(6):
            best, margin = _rank(_photograph(refs[i], rng), refs)
            assert best == i, f"{folder}/{name}: matched {names[best]} instead"
            assert margin >= MIN_MARGIN, (
                f"{folder}/{name}: margin {margin:.3f} is under {MIN_MARGIN} — the "
                "caller declines and falls back to the base card"
            )


def test_the_expensive_luffy_is_not_confused_with_the_cheap_one():
    """The card this whole path exists for.

    OP13-118 Red Super Alternate Art, US$19,999, against a sibling at US$2,116
    that shares its character, pose and frame. dHash scores those two ~0.80
    alike and its margin here averaged 0.031 — under the threshold, so it
    declined and the base card got priced at A$197 in a client meeting.
    """
    names, refs = _printings("op13-118-luffy")
    red = next(i for i, n in enumerate(names) if n.startswith("5-red"))
    rng = np.random.default_rng(3)

    margins = []
    for _ in range(12):
        best, margin = _rank(_photograph(refs[red], rng), refs)
        assert best == red, f"matched {names[best]} instead of the Red Super Alternate Art"
        margins.append(margin)

    assert float(np.mean(margins)) >= MIN_MARGIN * 2, (
        f"mean margin {np.mean(margins):.3f} leaves no headroom over {MIN_MARGIN}"
    )


def test_colour_is_what_separates_the_two_alternate_arts():
    """Why both halves are scored, stated as a fact rather than a comment."""
    names, refs = _printings("op13-118-luffy")
    red = next(i for i, n in enumerate(names) if n.startswith("5-red"))
    plain = next(i for i, n in enumerate(names) if n.startswith("4-super"))

    structure = similarity(dhash(refs[red]), dhash(refs[plain]))
    colour = hue_similarity(hue_signature(refs[red]), hue_signature(refs[plain]))

    assert structure > 0.7, "these two are near-identical in layout"
    assert colour < structure - 0.3, "hue is what tells them apart"
