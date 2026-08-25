"""OCR-based card identification hints.

Reads text off the warped card and extracts what the catalog lookup needs:
candidate names (prominent text near the top of the card) and the collector
number (e.g. "031/064"). Identification needs far less resolution than
grading, so this runs even on gate-rejected scans — a rejected photo can
still tell the user which card we saw.

The actual catalog match (TCGdex) happens in the API layer; this module only
reports what is printed on the card.
"""

import re

import cv2
import numpy as np

from .slab import extract as extract_slab

_ENGINE = None

COLLECTOR_RE = re.compile(r"\b(\d{1,3})\s*/\s*(\d{1,3})\b")
# game-specific set codes printed in Latin script even on Japanese cards
# The \b anchors used to sit on both ends, which meant the code had to stand
# alone in its token. One Piece prints the treatment markers flush against it —
# "SP OP07-085 SR" comes back from OCR as "SPOP07-085SR" — so a raw card whose
# number was plainly legible read as having no number at all, and got no price.
SET_CODE_RE = re.compile(
    r"(?<![A-Z0-9])(?:SP)?((?:OP|ST|EB|PRB)\d{2})\s*[-–]\s*(\d{3})(?!\d)",
    re.IGNORECASE,
)

_SLAB_COMPANIES = re.compile(r"\b(PSA|BGS|BECKETT|CGC|SGC|TAG|AGS)\b", re.IGNORECASE)
_COMPANY_ALIAS = {"BECKETT": "BGS"}
# The full PSA/BGS wording ladder. The old pattern stopped at EX-MT, so a
# genuine "EX 5" label matched nothing — and with the PSA logo unread too,
# parse_slab bailed and the card was never recognised as slabbed at all.
# Ordered longest-first so NM-MT is not consumed as NM, and VG-EX not as VG.
_SLAB_GRADE = re.compile(
    r"\b(GEM\s*M(?:IN)?T|PRISTINE|NM[-\s]?MT|VG[-\s]?EX|EX[-\s]?MT|MINT|AUTHENTIC"
    r"|POOR|FAIR|GOOD|NM|EX|VG|PR|FR)\b\s*\+?\s*(10|9(?:\.5)?|[1-8](?:\.5)?)?",
    re.IGNORECASE,
)
_CERT_RE = re.compile(r"\b(\d{7,10})\b")  # PSA 8-9 digits, BGS up to 10


# NB: \b would fail on "2006EXDRAGONFRONTIERS" — a digit followed by a
# letter is not a word boundary. Slab OCR routinely loses the spaces, so
# bound on digits only. This is what silently killed the whole label path.
_YEAR_RE = re.compile(r"(?<!\d)(19[6-9]\d|20[0-4]\d)(?!\d)")
_LABEL_NUM_RE = re.compile(r"#\s*([A-Z]{0,3}\d{1,3})(?!\d)")  # \b fails on "#100CHARIZARD"
# same OCR space-loss, on the number line: "#100 CHARIZARD" -> "100CHARIZARD"
# A leading number glued to a word is usually the card number ("100CHARIZARD"),
# but not when the word makes it an ordinal or a count: "1ST EDITION" and
# "11 ADDITIONAL GAME CARDS" are not card #1 and card #11.
_LEADING_NUM_RE = re.compile(r"^(\d{1,3})(?=[A-Za-z])")
_ORDINAL_RE = re.compile(r"^\d{1,3}(ST|ND|RD|TH)\b", re.IGNORECASE)
# grading-company furniture that is never part of the card or set name
_LABEL_NOISE = re.compile(
    r"\b(PSA|BGS|BECKETT|CGC|SGC|TAG|AGS|GEM|MINT|MT|NM|EX[-\s]?MT|PRISTINE|"
    r"AUTHENTIC|GRADE|POP|CERT|EDITION|1ST|UNLIMITED|SHADOWLESS)\b",
    re.IGNORECASE,
)
# OCR reads label caps badly: zero for O, one for I, five for S
_OCR_CONFUSIONS = str.maketrans({"0": "O", "1": "I", "5": "S", "8": "B"})


def _label_words(raw: str) -> str:
    """Undo OCR digit/letter confusions inside all-caps label words and split
    run-together tokens ("P0KEMONGAME" -> "POKEMON GAME")."""
    out = raw.translate(_OCR_CONFUSIONS)
    out = re.sub(r"[^A-Za-z\s'&.-]", " ", out)
    for word in ("POKEMON", "GAME", "SET", "SERIES", "HOLO"):
        out = re.sub(f"(?<=[A-Z]){word}", f" {word}", out)
    return re.sub(r"\s{2,}", " ", out).strip(" -.")


def parse_slab(texts: list) -> dict | None:
    """Detect a grading-company slab label from OCR'd text near the top of
    the image (company name + condition wording + cert number)."""
    top_texts = [t for t in texts if t["top"] < 0.30]
    joined = " ".join(t["text"] for t in top_texts)

    # The cascade decides whether this is a slab and what the grade tuple is.
    # It runs FIRST and its verdict is final in both directions: the legacy
    # gates below required grading WORDING plus a company or cert, which threw
    # away every label whose grade is a bare number ("SGC 88", "TAG 9.8") and
    # every sub-brand it had no pattern for.
    tup = extract_slab(joined)
    # Only a POSITIVE non-slab verdict vetoes. "No pattern matched" must not:
    # a PSA label with the grade digit obscured is still a PSA label, and
    # discarding it sent a Deoxys ex #93 to a POP Series 4 #2.
    if tup.declined:
        return None

    company = _SLAB_COMPANIES.search(joined)
    # Take the best grade match, not the first. A Beckett label reads
    # "2006 EX DRAGON FRONTIERS ... NM-MT+ 8.5": the set-name "EX" appears
    # first and would win a naive search, turning a NM-MT 8.5 into an EX.
    # A match carrying a number is the real grade; failing that, the most
    # specific wording is.
    grade = None
    _cands = list(_SLAB_GRADE.finditer(joined))
    if _cands:
        numbered = [m for m in _cands if m.group(2)]
        grade = max(numbered or _cands, key=lambda m: len(m.group(1)))
    cert = _CERT_RE.search(joined)
    if not tup.is_slab:
        # cascade found no grader/grade; fall back to the legacy requirement of
        # wording plus a company or cert before claiming this is a slab
        if not grade or not (company or cert):
            return None
    grade_text = grade.group(0).upper().strip() if grade else ""
    # legacy number recovery only applies to a legacy wording match. Where the
    # cascade supplied the grade there is nothing to recover, and `grade` may
    # legitimately be None ("SGC 88" carries no wording at all).
    if grade is not None and not grade.group(2):
        # PSA prints the numeric grade huge, on its own line, so the number is
        # a separate token from the wording. Take the one NEAREST the grade
        # word rather than the first in the list: photos are often screenshots
        # of listings or social posts, and the frame is full of unrelated
        # numerals. A "GEM MT 10" once became "GEM MT 5" because a post's like
        # count appeared earlier in the reading order.
        def _token_index_of(offset: int) -> int:
            pos = 0
            for i, t in enumerate(top_texts):
                nxt = pos + len(t["text"]) + 1  # +1 for the joining space
                if offset < nxt:
                    return i
                pos = nxt
            return len(top_texts) - 1

        anchor = _token_index_of(grade.start())
        numeric = [
            (i, t["text"].strip())
            for i, t in enumerate(top_texts)
            if re.fullmatch(r"(10|9(?:\.5)?|[1-8](?:\.5)?)", t["text"].strip())
        ]
        if numeric:
            # after the wording beats before it, then nearest wins
            i, standalone = min(numeric, key=lambda p: (p[0] < anchor, abs(p[0] - anchor)))
            grade_text = f"{grade_text} {standalone}"
    if company:
        raw_company = _COMPANY_ALIAS.get(company.group(1).upper(), company.group(1).upper())
    else:
        # The company logo frequently fails to OCR, and defaulting to PSA
        # printed "PSA" on Beckett slabs — a claim about someone else's
        # certification that we had no evidence for.
        #
        # Beckett labels carry a signature PSA labels never do: the four
        # subgrade captions, and a "+" suffix on the grade word. Those are read
        # far more reliably than the logo. Cert length is the last resort, and
        # when nothing indicates a company we now say so instead of guessing.
        beckett_markers = sum(
            1 for w in ("CENTERING", "CORNERS", "EDGES", "SURFACE") if w in joined.upper()
        )
        if beckett_markers >= 2 or re.search(r"\bNM[-\s]?MT\s*\+", joined, re.IGNORECASE):
            raw_company = "BGS"
        elif cert and len(cert.group(1)) == 10:
            raw_company = "BGS"
        elif cert and len(cert.group(1)) in (8, 9):
            raw_company = "PSA"
        else:
            raw_company = "UNKNOWN"
    # The label is the answer key: year + set + collector number identify a
    # graded card exactly, with no fuzzy name matching needed. Harvesting it
    # is the difference between "Charizard, some set" and one specific card.
    def _looks_like_year(raw: str) -> bool:
        """Is this line's leading number really a mangled year?

        OCR confuses 0/O, 1/I/T/l and 5/S, so "2021 POKEMON SWSH" arrives as
        "2O2TPOKEMONSWSH". Undo those substitutions before deciding: a four
        character run that becomes a plausible year under them was a year.
        """
        head = raw[:4]
        if len(head) < 4:
            return False
        fixed = head.translate(str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1",
                                              "T": "1", "S": "5", "B": "8"}))
        return bool(re.fullmatch(r"(19[6-9]\d|20[0-4]\d)", fixed))

    def _repair_year(raw: str) -> str:
        """Put the digits back into a mangled leading year.

        The same substitutions that hid the year also left it in the set line:
        "2O2TPOKEMONSWSH" yielded no year and the set read "O T POKEMONSWSH".
        Repairing it recovers both, and is safe because it only rewrites a
        four character prefix that becomes a real year and nothing else.
        """
        if not _looks_like_year(raw):
            return raw
        fixed = raw[:4].translate(str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1",
                                                 "T": "1", "S": "5", "B": "8"}))
        return fixed + raw[4:]

    def _clean_label(raw: str) -> str:
        out = _LABEL_NOISE.sub(" ", _label_words(_YEAR_RE.sub(" ", raw)))
        return re.sub(r"\s{2,}", " ", out).strip(" -.")

    year = None
    set_line = None
    label_number = None
    # a bare leading digit, held back in case a "#NNN" turns up on another line
    loose_number = None
    for idx, t in enumerate(top_texts):
        raw = _repair_year(t["text"].strip())
        m = _YEAR_RE.search(raw)
        if m and year is None:
            year = m.group(1)
            rest = _clean_label(raw)
            if len(rest) >= 3:
                set_line = rest
            else:
                # PSA prints "1999 POKEMON GAME" as one line, BGS splits the
                # year onto its own — look ahead for the set on the next lines
                for nxt in top_texts[idx + 1 : idx + 3]:
                    txt = nxt["text"].strip()
                    if _LABEL_NUM_RE.search(txt) or _CERT_RE.fullmatch(txt.replace(" ", "")):
                        continue
                    cand = _clean_label(txt)
                    if len(cand) >= 4 and sum(ch.isalpha() for ch in cand) >= 4:
                        set_line = cand
                        break
        # A "#215" anywhere on the label outranks a bare leading digit
        # anywhere else, no matter which line comes first. Taking whichever
        # matched earliest read a PSA Umbreon VMAX #215 as card #2: OCR turned
        # the year "2021" into "2O2T", the leading-digit rule fired on its 2,
        # and the perfectly readable "#215" two tokens later never got a look.
        # Evolving Skies #2 is a Hoppip.
        hit = _LABEL_NUM_RE.search(raw)
        if hit:
            label_number = hit.group(1).lstrip("#").strip()
        elif label_number is None and not _ORDINAL_RE.match(raw.strip()):
            loose = _LEADING_NUM_RE.search(raw)
            # ...and a mangled year is not a card number either
            if loose and not _looks_like_year(raw):
                loose_number = loose.group(1).strip()

    if label_number is None and loose_number is not None:
        label_number = loose_number

    # A year is a nice anchor but not a requirement: plenty of labels OCR
    # without a readable one, and bailing then throws away the set — which
    # drops the whole card to fuzzy name matching on the card face, where
    # "Charizard Star δ" scores HIGHER against "Charizard VSTAR" (0.88) than
    # against the real "Charizard ☆ δ" (0.80). Recover the set from the most
    # set-looking label line instead.
    if set_line is None:
        for t in top_texts:
            raw = t["text"].strip()
            if _CERT_RE.fullmatch(raw.replace(" ", "")):
                continue
            cand = _clean_label(_LEADING_NUM_RE.sub(" ", raw))
            # a set line is mostly letters and longer than a grade token
            if len(cand) >= 6 and sum(ch.isalpha() for ch in cand) >= 6:
                set_line = cand
                break

    # the name line: most alphabetic label text that isn't the set line,
    # the company, or condition wording
    label_name = None
    best_len = 0
    for t in top_texts:
        raw = t["text"].strip()
        if _YEAR_RE.search(raw) or _CERT_RE.fullmatch(raw.replace(" ", "")):
            continue
        # drop the "#100" prefix first: _label_words would read its digits
        # as letters ("100" -> "IOO") and glue them onto the name
        without_num = _LABEL_NUM_RE.sub(" ", raw)
        without_num = re.sub(r"^\s*\d{1,3}\b", " ", without_num)
        cleaned = _LABEL_NOISE.sub(" ", _label_words(without_num))
        cleaned = re.sub(r"\s{2,}", " ", cleaned).strip(" -.")
        alpha = sum(ch.isalpha() for ch in cleaned)
        if alpha >= 4 and alpha > best_len and cleaned.upper() != (set_line or "").upper():
            best_len = alpha
            label_name = cleaned

    # Which label line holds the SET is not fixed. PSA prints
    #   2002 POKEMON        <- year + brand
    #   CHARIZARD-REV.FOIL  <- card
    #   LEGENDARY COLLECTION<- set
    # so the year-bearing line yields only "POKEMON" and the real set lands in
    # `name`. Guessing which line is which sent a Legendary Collection
    # Charizard to a Dragon Frontiers Gold Star. Rather than guess, hand the
    # catalogue every plausible line and let it score them — it knows the set
    # names, we do not.
    generic = {"POKEMON", "PKMN", "TCG", "SWSH", "SM", "XY", "BW", "EX", "SV", ""}
    candidates: list[str] = []
    for cand in (set_line, label_name, *(_clean_label(t["text"]) for t in top_texts)):
        if not cand:
            continue
        c = cand.strip()
        words = [w for w in re.split(r"\s+", c.upper()) if w]
        if not words or all(w in generic for w in words):
            continue  # nothing but era/brand furniture
        if sum(ch.isalpha() for ch in c) < 4:
            continue
        if c.upper() not in {x.upper() for x in candidates}:
            candidates.append(c)

    # The authoritative read is the TUPLE from the cascade: it knows Beckett
    # sub-brands, qualifiers, label colours, the SGC legacy scale and the
    # negative guards, none of which a company+string pair can express.
    # `company`/`gradeText` stay for now so existing callers keep working; they
    # are removed in the composite-key phase.
    if not tup.is_slab and tup.reason:
        # the cascade positively identified this as NOT a slab (lot, seller
        # opinion, raw-card review). That verdict beats the loose read above.
        return None

    if tup.is_slab and tup.grade is not None:
        if not grade_text:
            # no wording survived OCR ("SGC 88", "TAG 9.8") — show the tuple
            grade_text = f"{tup.grader} {tup.grade:g}".strip()
        elif not re.search(r"\d", grade_text):
            # wording read but the digit did not ("MINT" with no 9). The scale
            # supplies it, so print it — a display string with no number leaves
            # every downstream reader parsing for one that is not there.
            grade_text = f"{grade_text} {tup.grade:g}".strip()
        else:
            # The display string picked up a number, but the cascade is the
            # authority on what the grade IS. Where they disagree the string is
            # wrong: on a "1999 JUNGLE FOIL PACK / 1ST EDITION" label the
            # standalone-number search found the 1 of "1ST" and printed a PSA 10
            # as "GEM MT 1". One label, two different grades on screen.
            shown = re.search(r"\d+(?:\.\d)?", grade_text)
            if shown and abs(float(shown.group(0)) - tup.grade) > 1e-9:
                grade_text = (
                    grade_text[: shown.start()] + f"{tup.grade:g}" + grade_text[shown.end():]
                ).strip()
    if tup.qualifier and tup.qualifier not in grade_text:
        grade_text = f"{grade_text} ({tup.qualifier})".strip()

    return {
        "company": tup.grader or raw_company,
        "grader": tup.grader or raw_company,
        "grade": tup.grade,
        "qualifier": tup.qualifier,
        "label": tup.label,
        "subgrades": tup.subgrades or None,
        "tier": tup.tier,
        "setCandidates": candidates,
        "gradeText": grade_text,
        "certNumber": cert.group(1) if cert else None,
        "year": year,
        "setLine": set_line,
        "cardNumber": label_number,
        "name": label_name,
    }
# tokens that are card stats, not part of the name
_NAME_STOP = re.compile(r"\b(hp|ex|gx|v|vmax|vstar)\b\s*\d*$", re.IGNORECASE)


def _engine():
    global _ENGINE
    if _ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR

        _ENGINE = RapidOCR()
    return _ENGINE


def _clean_name(text: str) -> str:
    # strip HP values and stray digits that OCR merges into the title line
    text = re.sub(r"\b\d{2,4}\b", " ", text)
    text = re.sub(r"\bHP\b", " ", text, flags=re.IGNORECASE)
    # OCR often loses spaces between words: "MegaSlowbroex" -> "Mega Slowbro ex"
    text = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", text)
    # drop trailing 1-2 char fragments (mangled "ex"/"GX" logos)
    tokens = text.split()
    while tokens and len(tokens[-1]) <= 2:
        tokens.pop()
    text = " ".join(tokens) if tokens else text
    return re.sub(r"\s{2,}", " ", text).strip(" -–—.·")


def read_card_text(warped: np.ndarray) -> dict:
    h, w = warped.shape[:2]
    # normalize height for OCR: big enough to read, small enough to fit in
    # RAM on constrained machines (this box OOMs above ~1000px inference)
    target_h = 800
    if h != target_h:
        scale = target_h / h
        warped = cv2.resize(
            warped, (int(w * scale), target_h), interpolation=cv2.INTER_CUBIC
        )
        h, w = warped.shape[:2]

    empty = {
        "nameCandidates": [],
        "collectorNumber": None,
        "setCode": None,
        "slab": None,
        "texts": [],
        "language": "unknown",
        "japaneseTextDetected": False,
    }
    def _run(img):
        try:
            r, _ = _engine()(img)
            return r or []
        except Exception:
            # OCR can fail under memory pressure — free what we can, retry once
            import gc

            gc.collect()
            try:
                r, _ = _engine()(img)
                return r or []
            except Exception:
                return []

    result = _run(warped)
    # landscape-designed cards arrive rotated to portrait, making their text
    # vertical and unreadable — if the pass reads almost nothing, retry the
    # other orientation and keep whichever read more
    if sum(len(r[1]) for r in result) < 25:
        rotated = cv2.rotate(warped, cv2.ROTATE_90_COUNTERCLOCKWISE)
        alt = _run(rotated)
        if sum(len(r[1]) for r in alt) > sum(len(r[1]) for r in result):
            result = alt
            warped = rotated
            h, w = warped.shape[:2]
    if not result:
        return empty

    texts = []
    for box, text, score in result:
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        texts.append(
            {
                "text": text.strip(),
                "score": float(score),
                "top": float(min(ys) / h),
                "height": float((max(ys) - min(ys)) / h),
                "left": float(min(xs) / w),
            }
        )

    collector = None
    for t in texts:
        # collector number sits in the bottom band of the card
        if t["top"] > 0.80:
            m = COLLECTOR_RE.search(t["text"])
            if m:
                collector = f"{int(m.group(1)):03d}/{int(m.group(2)):03d}"
                break

    # set codes (e.g. OP07-109) identify the card exactly, even when the
    # name is printed in Japanese — search all read text
    set_code = None
    for t in texts:
        m = SET_CODE_RE.search(t["text"])
        if m:
            set_code = f"{m.group(1).upper()}-{m.group(2)}"
            break

    # name = prominent text in the top band, biggest glyphs first.
    # Filter card-frame furniture that outsizes the name on modern layouts:
    # HP values ("M360", "HP120"), evolution labels ("STAGE2", "BASIC").
    def _is_name_like(raw: str) -> bool:
        cleaned = _clean_name(raw)
        if len(cleaned) < 3:
            return False
        compact = re.sub(r"\s+", "", raw)
        digits = sum(ch.isdigit() for ch in compact)
        if digits / max(len(compact), 1) > 0.34:
            return False
        return not re.match(r"^(stage|basic|hp|lv)\W*\d*$", cleaned, re.IGNORECASE)

    top_band = [
        t
        for t in texts
        if t["top"] < 0.15 and t["score"] > 0.6 and _is_name_like(t["text"])
    ]
    top_band.sort(key=lambda t: t["height"], reverse=True)

    # not every game puts the name at the top (Top Trumps banners it mid-card,
    # sports cards often print it at the bottom): also consider unusually
    # large name-like text anywhere on the card
    tallest = top_band[0]["height"] if top_band else 0.0
    banners = [
        t
        for t in texts
        if 0.15 <= t["top"] < 0.92
        and t["score"] > 0.6
        and _is_name_like(t["text"])
        and t["height"] >= max(tallest, 0.02)
    ]
    banners.sort(key=lambda t: t["height"], reverse=True)

    names = []
    for t in top_band[:3] + banners[:2]:
        cleaned = _clean_name(t["text"])
        if cleaned and cleaned.lower() not in [n.lower() for n in names]:
            names.append(cleaned)

    all_text = " ".join(t["text"] for t in texts)
    # kana is unambiguous Japanese; CJK ideographs also appear when the OCR
    # model reads kana/kanji as Chinese glyphs, so both count as evidence
    # A single CJK glyph does not make a Japanese printing. One Piece prints
    # 特 ("SPECIAL") and 商 on ENGLISH cards, and matching any CJK character at
    # all declared an English Stussy to be Japanese — which then priced it
    # against the Japanese printing, a different card at a different price.
    #
    # Kana is the reliable signal: it appears in Japanese rules text and
    # essentially never as decoration. Kanji has to clear a real count, because
    # a Japanese card's rules text carries dozens and a decorated English card
    # carries one or two.
    kana = len(re.findall(r"[぀-ヿ]", all_text))
    kanji = len(re.findall(r"[一-鿿]", all_text))
    japanese = kana >= 2 or kanji >= 6
    latin = len(re.findall(r"[A-Za-z]", all_text))
    cjk = len(re.findall(r"[぀-ヿ一-鿿]", all_text))
    language = "ja" if cjk > latin * 0.5 else ("en" if latin > 0 else "unknown")

    return {
        "nameCandidates": names,
        "collectorNumber": collector,
        "setCode": set_code,
        "slab": parse_slab(texts),
        "texts": [t["text"] for t in texts],
        "language": language,
        "japaneseTextDetected": japanese,
    }
