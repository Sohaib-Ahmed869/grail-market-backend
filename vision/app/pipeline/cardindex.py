"""The catalogue as pictures: every card render we can reach, embedded once.

Built offline by `vision/scripts/build_index.py` into `vision/index/`:

  vectors.npy   float16, one L2-normalised row per card image
  meta.jsonl    one JSON object per row: game, cardId, name, setId, setName,
                number, imageUrl — the cardId in the backend's own format, so a
                match plugs straight into the existing identification code

Search is an exact dot product over the whole matrix. At 50,000 rows of 768
dims that is a few milliseconds on one core and needs no ANN library — an
approximate index would add a dependency and a recall question for no
measurable gain at this size.
"""

from __future__ import annotations

import json
import os
import re
import threading

import numpy as np

INDEX_DIR = os.environ.get(
    "CARD_INDEX_DIR",
    os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "index")),
)

_lock = threading.Lock()
_loaded: "CardIndex | None" = None

_PAREN = re.compile(r"\s*\([^)]*\)")


def card_key(meta: dict) -> str:
    """Which CARD a row is, ignoring which printing.

    Catalogues spell the printing into the name — "Sabo (001) (Alternate
    Art)" beside "Sabo" — so comparing names treats two printings of one card
    as two cards, and the margin between them comes out as a near-tie. One
    Piece keys on its number without the _pN suffix; everything else on the
    name with parenthesised printing words removed."""
    if meta.get("game") == "onepiece" and meta.get("number"):
        return f"onepiece:{str(meta['number']).upper()}"
    name = _PAREN.sub("", str(meta.get("name") or "")).strip().lower()
    return f"{meta.get('game')}:{name}"


class CardIndex:
    def __init__(self, vectors: np.ndarray, meta: list[dict]):
        self.vectors = vectors
        self.meta = meta

    @property
    def size(self) -> int:
        return len(self.meta)

    def search(self, query: np.ndarray, k: int = 10, games: set[str] | None = None) -> list[dict]:
        scores = self.vectors @ query.astype(self.vectors.dtype)
        scores = scores.astype(np.float32)
        if games:
            mask = np.fromiter((m.get("game") in games for m in self.meta), bool, count=len(self.meta))
            scores = np.where(mask, scores, -1.0)
        k = min(k, len(scores))
        if k <= 0:
            return []
        top = np.argpartition(-scores, k - 1)[:k]
        top = top[np.argsort(-scores[top])]
        return [{**self.meta[i], "score": round(float(scores[i]), 4)} for i in top if scores[i] > -1.0]


def load(force: bool = False) -> "CardIndex | None":
    """The index, loaded once. None when it has not been built yet."""
    global _loaded
    with _lock:
        if _loaded is not None and not force:
            return _loaded
        vec_path = os.path.join(INDEX_DIR, "vectors.npy")
        meta_path = os.path.join(INDEX_DIR, "meta.jsonl")
        if not (os.path.exists(vec_path) and os.path.exists(meta_path)):
            return None
        vectors = np.load(vec_path, mmap_mode="r")
        # An index built by the other embedder is not searchable by this one:
        # the widths differ, and where they did not the scores would be
        # meaningless rather than wrong-looking. Refuse it like a missing index.
        from . import embed

        if vectors.ndim != 2 or vectors.shape[1] != embed.dims():
            print(
                f"[cardindex] index is {getattr(vectors, 'shape', None)} but the "
                f"{embed.backend()} embedder produces {embed.dims()} dims — rebuild it "
                "with scripts/build_index.py",
                flush=True,
            )
            return None
        with open(meta_path, encoding="utf-8") as f:
            meta = [json.loads(line) for line in f if line.strip()]
        n = min(len(meta), vectors.shape[0])
        _loaded = CardIndex(np.asarray(vectors[:n]), meta[:n])
        return _loaded
