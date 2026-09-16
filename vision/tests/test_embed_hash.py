"""The no-model embedder: dHash structure plus the glare-stripped hue signature,
packed into one unit vector so the index's dot product IS match.py's combined
score rather than an approximation of it.

These are the properties that hold whatever the accuracy measurement says —
the width the index is built at, the unit norm the dot product assumes, and
the refusal to search an index built by the other backend.
"""

import numpy as np
import pytest

from app.pipeline import cardindex, embed


@pytest.fixture
def hash_backend(monkeypatch):
    monkeypatch.setenv("EMBED_BACKEND", "hash")


def card(seed: int, w: int = 300, h: int = 420) -> np.ndarray:
    """A deterministic fake card: coloured blocks, so hue and structure differ
    between seeds the way two different artworks do."""
    rng = np.random.default_rng(seed)
    img = np.zeros((h, w, 3), np.uint8)
    for j in range(6):
        for i in range(4):
            img[j * h // 6:(j + 1) * h // 6, i * w // 4:(i + 1) * w // 4] = rng.integers(0, 255, 3)
    return img


def test_hash_backend_needs_no_model(hash_backend):
    # The whole point: nothing to download, so recognition is never "unavailable"
    # for want of an 84 MB file.
    assert embed.available() is True
    assert embed.backend() == "hash"
    assert embed.dims() == embed.HASH_DIMS == 496


def test_vectors_are_unit_length_at_the_indexed_width(hash_backend):
    v = embed.embed(card(1))
    assert v.shape == (496,)
    assert v.dtype == np.float32
    # cardindex scores with a plain dot product, which is only a cosine if the
    # rows are normalised.
    assert np.linalg.norm(v) == pytest.approx(1.0, abs=1e-5)


def test_the_same_card_scores_one_and_a_different_card_scores_less(hash_backend):
    a, b = embed.embed(card(1)), embed.embed(card(2))
    assert float(a @ a) == pytest.approx(1.0, abs=1e-5)
    assert float(a @ b) < 0.9


def test_a_card_lying_on_its_side_is_the_same_card(hash_backend):
    # /analyze hands over a flattened card, but a landscape crop still arrives.
    # Both backends turn landscape to portrait CLOCKWISE, so a card rotated
    # anti-clockwise off upright is restored exactly.
    upright = card(3)
    on_its_side = np.rot90(upright, 1).copy()
    assert float(embed.embed(upright) @ embed.embed(on_its_side)) > 0.99


def test_a_card_turned_the_other_way_is_not_recovered(hash_backend):
    # ...and the other direction is NOT: one clockwise turn leaves it upside
    # down, 180 degrees from the render it has to match. DINOv2's prepare()
    # applies the identical rule, so this is the pipeline's standing
    # limitation — the detector is expected to hand over an upright card —
    # and not something the hash backend introduced. Recorded rather than
    # asserted away, so that a fix to either backend has a fixture waiting.
    upright = card(3)
    other_way = np.rot90(upright, 3).copy()
    assert float(embed.embed(upright) @ embed.embed(other_way)) < 0.9


def test_an_index_built_by_the_other_backend_is_refused(hash_backend, tmp_path, monkeypatch):
    # Searching 768-dim DINOv2 rows with a 496-dim hash query would either
    # raise or, worse, score something. It reads as "no index" instead.
    np.save(tmp_path / "vectors.npy", np.zeros((4, 768), np.float16))
    (tmp_path / "meta.jsonl").write_text(
        "\n".join('{"game": "onepiece", "cardId": "optcg-OP01-%03d"}' % i for i in range(4)),
        encoding="utf-8",
    )
    monkeypatch.setattr(cardindex, "INDEX_DIR", str(tmp_path))
    assert cardindex.load(force=True) is None


def test_an_index_at_the_matching_width_loads(hash_backend, tmp_path, monkeypatch):
    rows = np.stack([embed.embed(card(i)) for i in range(3)]).astype(np.float16)
    np.save(tmp_path / "vectors.npy", rows)
    (tmp_path / "meta.jsonl").write_text(
        "\n".join('{"game": "onepiece", "cardId": "optcg-OP01-00%d", "number": "OP01-00%d"}' % (i, i)
                  for i in range(3)),
        encoding="utf-8",
    )
    monkeypatch.setattr(cardindex, "INDEX_DIR", str(tmp_path))
    index = cardindex.load(force=True)
    assert index is not None and index.size == 3
    # and the card it was built from comes back first
    assert index.search(embed.embed(card(1)), k=1)[0]["cardId"] == "optcg-OP01-001"
