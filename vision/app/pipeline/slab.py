"""Slab extraction — turning label text into a grade TUPLE.

A grade is not a number. It is (grader, grade, qualifier, label, subgrades),
and pricing must key on the whole thing. See docs/solution-architecture.md §5
and docs/grading-knowledge-base.md §2.

Two properties matter more than coverage:

  Order is load-bearing. Specific patterns fire before generic ones, so
  "BCCG 10" can never fall through to a bare "10" and get priced like a
  Beckett gem — that single mistake overvalues by 10-50x.

  A grade token is not a graded card. "PSA 10 CANDIDATE" is a raw card with a
  seller's opinion attached. Negative guards run before anything else.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# ── tiers ────────────────────────────────────────────────────────────────────
# Never price across tiers. A BCCG 10 and a BGS 10 are not comparable goods.
TIERS: dict[str, str] = {
    "PSA": "premium", "BGS": "premium", "BVG": "premium",
    "CGC": "premium", "SGC": "premium",
    "TAG": "emerging", "ACE": "emerging", "AGS": "emerging", "MNT": "emerging",
    "BCCG": "discount", "GMA": "discount", "KSA": "discount",
    "HGA": "discount", "CSG": "discount",
}

# PSA's grade word and grade number are the same fact printed twice: the scale
# is published and fixed, so MINT is always 9 and GEM MT is always 10. That
# redundancy is worth using, because the two are not equally readable. The word
# is several characters with redundant shape; the number is a single isolated
# glyph, and OCR read the 9 on a MINT label as a 6 — which then priced a PSA 9
# as a PSA 6. Where the word is legible it decides, and the digit only confirms.
#
# A trailing "+" marks the half grade below the next word (NM-MT+ is 8.5).
# Note there is no PSA 9.5: the ladder runs 9 -> 10.
PSA_WORD_GRADE: dict[str, float] = {
    "GEM MT": 10.0, "GEM MINT": 10.0,
    "MINT": 9.0,
    "NM-MT": 8.0, "NM MT": 8.0, "NMMT": 8.0,
    "NM": 7.0, "NEAR MINT": 7.0,
    "EX-MT": 6.0, "EX MT": 6.0, "EXMT": 6.0,
    "EX": 5.0,
    "VG-EX": 4.0, "VG EX": 4.0, "VGEX": 4.0,
    "VG": 3.0,
    "GOOD": 2.0,
    "FR": 1.5, "FAIR": 1.5,
    "PR": 1.0, "POOR": 1.0,
}


def psa_grade_from_word(U: str) -> float | None:
    """PSA grade implied by the printed word, half-step if it carries a '+'."""
    for word in sorted(PSA_WORD_GRADE, key=len, reverse=True):
        m = re.search(r"\b" + word.replace(" ", r"[-\s]?") + r"\b\s*(\+)?", U)
        if not m:
            continue
        g = PSA_WORD_GRADE[word]
        if m.group(1) and g < 10:
            g += 0.5          # NM-MT+ is 8.5
        return g
    return None


# SGC's pre-2018 slabs use a 100-point scale. 88 is an 8, not a nonsense grade.
SGC_LEGACY: dict[int, float] = {
    100: 10.0, 98: 9.0, 96: 9.0, 92: 8.5, 88: 8.0, 86: 7.5, 84: 7.0,
    80: 6.0, 70: 5.5, 60: 5.0, 55: 4.5, 50: 4.0, 45: 3.5, 40: 3.0,
    35: 2.5, 30: 2.0, 20: 1.5, 10: 1.0,
}

# Wording that means the seller is speculating, not reporting a certification.
_NEGATIVE = re.compile(
    r"\b(CANDIDATE|WOULD\s*GRADE|GRADE\s*WORTHY|READY\s*(?:FOR|TO)\s*GRADE"
    r"|PRE[-\s]?GRADE|NOT\s*GRADED|UN[-\s]?GRADED|WILL\s*GRADE|GRADEABLE)\b",
    re.IGNORECASE,
)
# Multi-card listings: a single-card price applied to a lot is always wrong.
_LOT = re.compile(
    r"\b(LOT\s*(?:OF)?\s*\d*|BUNDLE|JOB\s*LOT|x\s?\d{1,3}\b|PICK\s*(?:YOUR|A)"
    r"|CHOOSE\s*(?:YOUR|A)|READ\s*DESCRIPTION)\b",
    re.IGNORECASE,
)
_CERT = re.compile(r"(?<!\d)(\d{7,10})(?!\d)")
_NUM = r"(\d{1,3}(?:\.\d)?)"


@dataclass
class SlabRead:
    grader: str | None = None
    grade: float | None = None
    qualifier: str | None = None
    label: str | None = None          # black | gold | pristine | gem | silver
    subgrades: dict[str, float] = field(default_factory=dict)
    cert: str | None = None
    tier: str | None = None
    is_slab: bool = False
    reason: str | None = None         # why we declined, when we decline
    # True only when we POSITIVELY determined this is not a slab (a lot, a
    # seller's opinion, a Raw Card Review). Failing to find a grade is NOT the
    # same thing and must not be treated as one: a PSA label whose grade digit
    # is obscured is still a PSA label, and discarding it drops the card to
    # fuzzy name matching.
    declined: bool = False

    def as_dict(self) -> dict:
        return {
            "grader": self.grader,
            "grade": self.grade,
            "qualifier": self.qualifier,
            "label": self.label,
            "subgrades": self.subgrades or None,
            "cert": self.cert,
            "tier": self.tier,
            "isSlab": self.is_slab,
            "reason": self.reason,
        }


def _f(v: str | None) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _valid(g: float | None) -> bool:
    return g is not None and 0.5 <= g <= 10.0


def extract(text: str) -> SlabRead:
    """Read a grade tuple out of label or title text.

    Returns is_slab=False with a reason where the text is a raw card, a lot, or
    a seller's opinion. Callers must treat that as authoritative: a declined
    read is a correct answer, not a failure to try.
    """
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return SlabRead(reason="empty")
    U = t.upper()

    # ── guards first: nothing below should get the chance to fire ───────────
    if _NEGATIVE.search(U):
        return SlabRead(reason="seller opinion, not a certification", declined=True)
    if _LOT.search(U):
        return SlabRead(reason="multi-card lot", declined=True)
    # "Raw Card Review" is an opinion in a sleeve, not a tamper-evident holder
    if re.search(r"\bB?RCR\b|\bRAW\s*CARD\s*REVIEW\b", U):
        return SlabRead(reason="Beckett Raw Card Review is not a slab", declined=True)
    # a grade immediately questioned is a guess: "GEM MINT 10?"
    if re.search(r"\b(?:10|9(?:\.5)?|[1-8](?:\.5)?)\s*\?", U):
        return SlabRead(reason="grade is speculative", declined=True)

    cert = _CERT.search(t)
    cert_s = cert.group(1) if cert else None

    for rule in _CASCADE:
        got = rule(U)
        if got is not None:
            got.cert = got.cert or cert_s
            got.tier = TIERS.get(got.grader or "", None)
            got.is_slab = True
            return got

    named = re.search(r"\b(PSA|BGS|BECKETT|BVG|BCCG|CGC|SGC|TAG|ACE|AGS)\b", U)
    if named or cert_s:
        grader = named.group(1).upper() if named else None
        if grader == "BECKETT":
            grader = "BGS"
        # A slab we can see but whose grade we cannot read. Say so: the grader
        # and cert are still useful for identification, and a null grade stops
        # anything downstream pricing it at a grade we never actually read.
        return SlabRead(
            grader=grader,
            grade=None,
            cert=cert_s,
            tier=TIERS.get(grader or "", None),
            is_slab=True,
            reason="grade not readable on this label",
        )
    return SlabRead(cert=cert_s, reason="no grader/grade pattern matched")


# ── the cascade, most specific first ─────────────────────────────────────────

def _bgs_black_label(U: str) -> SlabRead | None:
    if not re.search(r"\bBLACK\s*LABEL\b", U):
        return None
    if not re.search(r"\bBGS|BECKETT\b", U):
        return None
    return SlabRead(grader="BGS", grade=10.0, label="black")


def _bgs_subgrades(U: str) -> SlabRead | None:
    """BGS 9.5 (10/9.5/9.5/9) — the parenthesised block is the four subgrades.

    The overall grade is the one OUTSIDE the brackets. A parser that grabs the
    first number inside reports a 10 for a 9.5 card.
    """
    m = re.search(
        r"\b(?:BGS|BECKETT)\s*" + _NUM +
        r"\s*[\(\[]\s*" + _NUM + r"\s*[/,]\s*" + _NUM +
        r"\s*[/,]\s*" + _NUM + r"\s*[/,]\s*" + _NUM + r"\s*[\)\]]",
        U,
    )
    if not m:
        return None
    overall = _f(m.group(1))
    if not _valid(overall):
        return None
    keys = ("centering", "corners", "edges", "surface")
    subs = {k: _f(m.group(i + 2)) for i, k in enumerate(keys)}
    return SlabRead(grader="BGS", grade=overall,
                    subgrades={k: v for k, v in subs.items() if v is not None},
                    label=_bgs_label(overall, subs))


def _bgs_subgrade_captions(U: str) -> SlabRead | None:
    """A Beckett label prints the four captions; PSA labels never do.

    On a photographed slab the captions read more reliably than the logo, so
    they are a stronger grader signal than the word "BECKETT" itself.
    """
    caps = [w for w in ("CENTERING", "CORNERS", "EDGES", "SURFACE") if w in U]
    if len(caps) < 2:
        return None
    subs: dict[str, float] = {}
    for cap in ("CENTERING", "CORNERS", "EDGES", "SURFACE"):
        m = re.search(cap + r"\s*" + _NUM, U)
        v = _f(m.group(1)) if m else None
        if _valid(v):
            subs[cap.lower()] = v
    # the overall is the grade attached to the NM-MT/GEM wording, or a bare
    # half-grade token that is not one of the subgrade values
    m = re.search(r"\b(?:GEM\s*MT|GEM\s*MINT|PRISTINE|NM[-\s]?MT|MINT|NM|EX)\s*\+?\s*" + _NUM, U)
    overall = _f(m.group(1)) if m else None
    if not _valid(overall):
        overall = _first_plausible_grade(U)
    if not _valid(overall):
        return None
    return SlabRead(grader="BGS", grade=overall, subgrades=subs,
                    label=_bgs_label(overall, subs))


def _bgs_label(overall: float | None, subs: dict) -> str | None:
    if overall == 10.0:
        vals = [v for v in subs.values() if v is not None]
        if vals and all(v == 10.0 for v in vals) and len(vals) == 4:
            return "black"
        return "gold"
    if overall == 9.5:
        return "gold"
    return None


def _bccg(U: str) -> SlabRead | None:
    # BEFORE the BGS rule: BCCG contains no "BGS" but a loose matcher on
    # "BECKETT" or a bare number would misfile it as Beckett's main line.
    m = re.search(r"\bBCCG\s*" + _NUM, U)
    if not m:
        return None
    g = _f(m.group(1))
    return SlabRead(grader="BCCG", grade=g) if _valid(g) else None


def _bvg(U: str) -> SlabRead | None:
    m = re.search(r"\bBVG\s*" + _NUM, U)
    if not m:
        return None
    g = _f(m.group(1))
    return SlabRead(grader="BVG", grade=g) if _valid(g) else None


def _bgs_plain(U: str) -> SlabRead | None:
    m = re.search(
        r"\b(?:BGS|BECKETT(?:\s*GRAD(?:ED|ING))?)\s*"
        r"(?:GEM\s*MINT|PRISTINE|MINT|NM[-\s]?MT)?\s*\+?\s*" + _NUM,
        U,
    )
    if not m:
        return None
    g = _f(m.group(1))
    if not _valid(g):
        return None
    return SlabRead(grader="BGS", grade=g, label=_bgs_label(g, {}))


def _psa_qualified(U: str) -> SlabRead | None:
    m = re.search(r"\bPSA\s*" + _NUM + r"\s*\(?\s*(OC|ST|MK|PD|MC)\b\s*\)?", U)
    if not m:
        return None
    g = _f(m.group(1))
    if not _valid(g):
        return None
    return SlabRead(grader="PSA", grade=g, qualifier=m.group(2).upper())


def _psa_plain(U: str) -> SlabRead | None:
    if re.search(r"\bPSA\b", U):
        # the word decides where it is legible — see PSA_WORD_GRADE
        by_word = psa_grade_from_word(U)
        if _valid(by_word):
            return SlabRead(grader="PSA", grade=by_word)
    m = re.search(r"\bPSA\s*(?:GEM\s*M(?:IN)?T|MINT|NM[-\s]?MT)?\s*" + _NUM, U)
    if m:
        g = _f(m.group(1))
        if _valid(g):
            return SlabRead(grader="PSA", grade=g)
    # PSA's own wording with the number on its own line, logo unread. The
    # 8-9 digit cert is the tell that separates PSA from Beckett's 10.
    if re.search(r"\bPSA\b", U):
        g = _wording_grade(U)
        if _valid(g):
            return SlabRead(grader="PSA", grade=g)
    return None


def _cgc(U: str) -> SlabRead | None:
    m = re.search(r"\bCGC\s*(PRISTINE|GEM\s*MINT|MINT\s*\+|MINT)?\s*" + _NUM, U)
    if not m:
        return None
    g = _f(m.group(2))
    if not _valid(g):
        return None
    word = (m.group(1) or "").replace(" ", "").upper()
    # CGC has two different tens; "CGC 10" alone is ambiguous and the label
    # word is the only thing that separates them.
    label = "pristine" if word == "PRISTINE" else "gem" if word == "GEMMINT" else None
    return SlabRead(grader="CGC", grade=g, label=label)


def _sgc(U: str) -> SlabRead | None:
    m = re.search(r"\bSGC\s*" + _NUM, U)
    if not m:
        return None
    raw = _f(m.group(1))
    if raw is None:
        return None
    if raw > 10:  # legacy 100-point slab
        mapped = SGC_LEGACY.get(int(raw))
        return SlabRead(grader="SGC", grade=mapped) if mapped else None
    return SlabRead(grader="SGC", grade=raw) if _valid(raw) else None


def _emerging(U: str) -> SlabRead | None:
    m = re.search(r"\b(TAG|ACE|AGS|MNT|HGA|GMA|KSA|CSG)\s*" + _NUM, U)
    if not m:
        return None
    g = _f(m.group(2))
    return SlabRead(grader=m.group(1).upper(), grade=g) if _valid(g) else None


def _first_plausible_grade(s: str) -> float | None:
    """First standalone number that could actually BE a grade.

    Label text is full of numerals that are not grades — the year, the
    collector number, the cert. Stopping at the first match reads "#100" as a
    grade of 100 and gives up; skipping to the first in-range value finds the
    8.5 printed beside it.
    """
    # \w not \d on the boundaries: OCR mangles words into alphanumeric soup
    # ("DRAGON" -> "EX)4GON"), and a numeral wedged inside letters is never a
    # printed grade. A grade stands alone or follows a grade word.
    for m in re.finditer(r"(?<![\w./])" + _NUM + r"(?![\w./])", s):
        v = _f(m.group(1))
        if _valid(v):
            return v
    return None


def _wording_grade(U: str) -> float | None:
    """A grade number attached to, or sitting beside, grading wording."""
    m = re.search(
        r"\b(GEM\s*M(?:IN)?T|PRISTINE|NM[-\s]?MT|VG[-\s]?EX|EX[-\s]?MT|MINT"
        r"|POOR|FAIR|GOOD|NM|EX|VG)\b\s*\+?\s*" + _NUM + r"?",
        U,
    )
    if not m:
        return None
    if m.group(2):
        return _f(m.group(2))
    return _first_plausible_grade(U[m.end():])


def _by_cert_shape(U: str) -> SlabRead | None:
    """No grader name survived OCR, but there is grading wording and a cert.

    Cert length is a real signal: PSA issues 8-9 digits, Beckett 10. It is the
    last resort — every named-grader rule above is stronger — and it refuses
    rather than defaulting to PSA when the length says nothing.
    """
    g = _wording_grade(U)
    if not _valid(g):
        return None
    m = _CERT.search(U)
    if not m:
        return None
    n = len(m.group(1))
    if n == 10:
        return SlabRead(grader="BGS", grade=g)
    if n in (8, 9):
        return SlabRead(grader="PSA", grade=psa_grade_from_word(U) or g)
    return None


_CASCADE = [
    _bgs_black_label,
    _bgs_subgrades,
    _bccg,            # before any Beckett rule
    _bvg,
    _bgs_subgrade_captions,
    _bgs_plain,
    _psa_qualified,   # before plain PSA, or the qualifier is lost
    _psa_plain,
    _cgc,
    _sgc,
    _emerging,
    _by_cert_shape,   # last: only when no grader name was readable
]
