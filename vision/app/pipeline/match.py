"""Perceptual-hash visual matching.

dHash: resize to 9x8 grayscale, compare adjacent columns -> 64-bit signature.
Robust to lighting, scale, and mild color shifts, which makes it a good
cross-check between a photographed card and the catalog's official render.
Used to VERIFY OCR-driven candidates, not to search the whole catalog
(that's the Phase-2 embedding index).
"""

import urllib.request

import cv2
import numpy as np


def dhash(image: np.ndarray) -> int:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    bits = small[:, 1:] > small[:, :-1]
    return int("".join("1" if b else "0" for b in bits.flatten()), 2)


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def similarity(a: int, b: int) -> float:
    return 1.0 - hamming(a, b) / 64.0


def fetch_image(url: str, timeout: float = 6.0) -> np.ndarray | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "grailcard/0.1"})
        data = urllib.request.urlopen(req, timeout=timeout).read()
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        return img
    except Exception:
        return None
