"""All tunable thresholds live here, not scattered through the code.

These get tuned constantly against real photos; keeping them in one place is
what makes that safe. Values are starting points calibrated on the synthetic
fixture suite.
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class DetectConfig:
    canonical_w: int = 750
    canonical_h: int = 1050
    # candidate contour must cover at least this fraction of the frame
    min_contour_area_frac: float = 0.02
    # card quad area / image area below this -> reject card_too_small
    min_card_area_frac: float = 0.10
    # a quad covering nearly the whole frame is the frame, not a card
    max_card_area_frac: float = 0.95
    # aspect ratio (short/long side) window around the 63x88mm card = 0.716
    aspect_min: float = 0.55
    aspect_max: float = 0.90
    # card's short side in SOURCE pixels below this -> low-detail mode
    # (grading proceeds with reduced confidence and a wider band)
    min_source_width_px: int = 450
    # below this there is genuinely nothing to measure -> resolution_too_low
    hard_min_source_width_px: int = 280


@dataclass(frozen=True)
class QualityConfig:
    # Laplacian variance on the warped card below this -> too_blurry
    min_blur_score: float = 40.0
    # low-detail crops are upscaled to canonical size, which smooths them;
    # the blur floor scales down accordingly
    low_detail_blur_factor: float = 0.25
    # HSV thresholds for specular (blown-out) pixels
    glare_v_min: int = 250
    glare_s_max: int = 40
    # ignore specks smaller than this fraction of card area
    glare_min_cluster_frac: float = 0.0008
    # clustered glare above this % of card area -> too_much_glare
    max_glare_pct: float = 4.0


@dataclass(frozen=True)
class CenteringConfig:
    # search for the inner print border within this fraction of card width/height
    search_frac: float = 0.25
    # skip the first pixels inward (warp artifacts / rounded corners)
    min_offset_frac: float = 0.015
    # use only the central band of the perpendicular axis (avoid corners)
    band_lo: float = 0.15
    band_hi: float = 0.85
    # color-walk border scan: a pixel "leaves the border" when its distance
    # from the sampled border color exceeds this (BGR euclidean)
    color_tol: float = 42.0
    # the deviation must be sustained this many consecutive columns
    sustain_px: int = 4
    # fraction of band pixels that must deviate for a column to count
    dev_frac: float = 0.5
    # border reference ring must be this uniform to be a real border
    ring_uniform_min: float = 0.7
    # quality = contrast-past-border * ring uniformity; below min -> unmeasurable
    min_quality: float = 1.2
    # confidence mapping: conf = clip((quality - lo) / (hi - lo), 0, 1)
    conf_quality_lo: float = 1.0
    conf_quality_hi: float = 3.0
    # PSA centering standards (worst-side percentage, front)
    psa10_max: float = 60.0
    psa9_max: float = 65.0


@dataclass(frozen=True)
class PipelineConfig:
    detect: DetectConfig = field(default_factory=DetectConfig)
    quality: QualityConfig = field(default_factory=QualityConfig)
    centering: CenteringConfig = field(default_factory=CenteringConfig)


CONFIG = PipelineConfig()
