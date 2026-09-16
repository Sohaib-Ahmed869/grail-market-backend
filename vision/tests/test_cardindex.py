"""The image index's search: best score first, and a game filter that holds."""

import numpy as np

from app.pipeline.cardindex import CardIndex


def _index():
    vectors = np.eye(4, dtype=np.float16)
    meta = [
        {"game": "pokemon", "cardId": "a", "name": "A"},
        {"game": "pokemon", "cardId": "b", "name": "B"},
        {"game": "onepiece", "cardId": "c", "name": "C"},
        {"game": "pokemon", "cardId": "d", "name": "D"},
    ]
    return CardIndex(vectors, meta)


def test_best_match_first():
    hits = _index().search(np.array([0.1, 0.9, 0.8, 0.0], np.float32), k=2)
    assert [h["cardId"] for h in hits] == ["b", "c"]
    assert hits[0]["score"] > hits[1]["score"]


def test_game_filter_never_returns_another_game():
    hits = _index().search(np.array([0.1, 0.9, 0.8, 0.0], np.float32), k=3, games={"pokemon"})
    assert [h["cardId"] for h in hits] == ["b", "a", "d"]
    assert all(h["game"] == "pokemon" for h in hits)


def test_k_larger_than_index_is_fine():
    assert len(_index().search(np.array([1, 0, 0, 0], np.float32), k=50)) == 4
