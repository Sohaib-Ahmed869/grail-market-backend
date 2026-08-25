"""Digital-source heuristic.

Real photos of physical cards carry sensor noise everywhere — even 'flat'
areas have a measurable noise floor. Digital renders, screenshots, and
screen photos have large regions that are mathematically flat. We measure
the noise floor of the smoothest quartile of the warped card; an implausibly
clean floor flags the scan as likely-digital. Surfaced as a WARNING, not a
rejection: v0 errs on the side of informing rather than blocking.
"""

import cv2
import numpy as np

NOISE_FLOOR_MIN = 1.0  # sub-1.0 local std in flat regions ~ never happens on camera sensors


def digital_source_check(warped: np.ndarray) -> dict:
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)
    mean = cv2.blur(gray, (5, 5))
    sq_mean = cv2.blur(gray * gray, (5, 5))
    local_std = np.sqrt(np.maximum(sq_mean - mean * mean, 0))

    flat_cut = np.percentile(local_std, 25)
    noise_floor = float(np.median(local_std[local_std <= flat_cut]))

    return {
        "digitalLikely": bool(noise_floor < NOISE_FLOOR_MIN),
        "noiseFloor": round(noise_floor, 3),
    }
