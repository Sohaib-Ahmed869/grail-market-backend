"""Synthetic card photo generator with known ground truth.

Draws a card (light border + textured artwork) on a dark background, rotated
slightly like a real handheld shot. Border widths encode the requested
centering ratios exactly, so tests can assert measured vs true.
"""

import cv2
import numpy as np

BG = (45, 42, 40)
BORDER = (228, 232, 232)  # off-white border, below the glare threshold
ASPECT = 0.714  # 63mm / 88mm

# border budget as a fraction of card size (split between the two sides)
BORDER_X_FRAC = 0.14
BORDER_Y_FRAC = 0.12


def make_card_photo(
    lr: float = 50.0,
    tb: float = 50.0,
    img_w: int = 1600,
    img_h: int = 1200,
    card_h_frac: float = 0.78,
    angle_deg: float = 8.0,
    blur_sigma: float = 0.0,
    glare: bool = False,
    borderless: bool = False,
    seed: int = 42,
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    canvas = np.full((img_h, img_w, 3), BG, dtype=np.uint8)

    card_h = int(card_h_frac * img_h)
    card_w = int(card_h * ASPECT)
    x0 = (img_w - card_w) // 2
    y0 = (img_h - card_h) // 2

    # card border
    cv2.rectangle(canvas, (x0, y0), (x0 + card_w, y0 + card_h), BORDER, -1)

    # artwork window with centering-encoded offsets
    bx = BORDER_X_FRAC * card_w
    by = BORDER_Y_FRAC * card_h
    left = int(round(bx * lr / 100.0))
    right = int(round(bx)) - left
    top = int(round(by * tb / 100.0))
    bottom = int(round(by)) - top
    if borderless:
        left = right = top = bottom = 0

    ax0, ay0 = x0 + left, y0 + top
    ax1, ay1 = x0 + card_w - right, y0 + card_h - bottom
    art = rng.integers(30, 200, size=(ay1 - ay0, ax1 - ax0, 3), dtype=np.uint8)
    art = cv2.GaussianBlur(art, (5, 5), 0)  # soften noise so it reads as texture
    canvas[ay0:ay1, ax0:ax1] = art

    if glare:
        center = ((ax0 + ax1) // 2 + card_w // 6, (ay0 + ay1) // 2 + card_h // 5)
        axes = (card_w // 5, card_h // 7)
        cv2.ellipse(canvas, center, axes, 0, 0, 360, (255, 255, 255), -1)

    if angle_deg:
        m = cv2.getRotationMatrix2D((img_w / 2, img_h / 2), angle_deg, 1.0)
        canvas = cv2.warpAffine(
            canvas, m, (img_w, img_h), flags=cv2.INTER_LINEAR, borderValue=BG
        )

    if blur_sigma > 0:
        canvas = cv2.GaussianBlur(canvas, (0, 0), blur_sigma)

    return canvas
