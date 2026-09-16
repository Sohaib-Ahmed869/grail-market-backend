"""Card image embeddings — the recognition half of identification.

Everything else in this service reads TEXT off a card and hands names and
numbers to catalogues. That fails on exactly the cards people care about: holo
glare across the collector line, Japanese print, stylised fonts, and any card
whose number is on the back. A picture of the card is the one thing every scan
always has.

Two backends, chosen by EMBED_BACKEND:

  dinov2  DINOv2-small (Meta, Apache-2.0) through onnxruntime — the same
          runtime RapidOCR already uses, so no PyTorch. Trained for instance
          retrieval, which is the question asked here ("which of these 50,000
          renders is THIS card"). 84 MB on disk, ~259 MB resident, ~78 ms a
          card on two threads.

  hash    No model at all. dHash for structure and the glare-stripped hue
          signature for colour — the pair match.py already measures for the
          printing picker — packed into one vector so the index search, the
          scores and the /recognize contract are unchanged. Nothing to
          download, nothing resident beyond the index itself, and roughly a
          millisecond a card.

The two produce different vectors of different lengths, so an index built by
one cannot be searched by the other. cardindex.load() checks the stored width
against dims() and refuses an index built by the other backend, rather than
returning scores that mean nothing.

The whole card is resized, never centre-cropped: the name and the collector
number live at the top and bottom edges, and a square crop would cut both off.
308x224 keeps the card's 88:63 shape on the model's 14-pixel patch grid.
"""

from __future__ import annotations

import os
import threading

import cv2
import numpy as np

try:
    from .match import dhash, hue_signature
except ImportError:  # loaded by file path (build_index workers), no package
    import sys as _sys

    _sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from match import dhash, hue_signature  # type: ignore[no-redef]

MODEL_DIR = os.environ.get(
    "EMBED_MODEL_DIR",
    os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "models", "dinov2-small")),
)
MODEL_FILE = os.environ.get("EMBED_MODEL_FILE", "model.onnx")
HEIGHT, WIDTH = 308, 224
_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
_STD = np.array([0.229, 0.224, 0.225], np.float32)

# Structure is the more reliable half under bad photography; colour is the half
# that separates the printings that matter. Measured — see match.py.
_W_STRUCTURE, _W_COLOUR = 0.6, 0.4
_HASH_BITS = 64
HASH_DIMS = _HASH_BITS + 4 * 6 * 18  # dHash bits + hue cells x bins

_session = None
_lock = threading.Lock()


def backend() -> str:
    return os.environ.get("EMBED_BACKEND", "dinov2").strip().lower()


def dims() -> int:
    return HASH_DIMS if backend() == "hash" else 768


def model_path() -> str:
    return os.path.join(MODEL_DIR, MODEL_FILE)


def available() -> bool:
    """The hash backend is always available; DINOv2 needs its model file."""
    return True if backend() == "hash" else os.path.exists(model_path())


def _get_session():
    global _session
    with _lock:
        if _session is None:
            import onnxruntime as ort

            so = ort.SessionOptions()
            so.intra_op_num_threads = int(os.environ.get("EMBED_THREADS", "2"))
            so.inter_op_num_threads = 1
            _session = ort.InferenceSession(model_path(), so, providers=["CPUExecutionProvider"])
        return _session


def prepare(image_bgr: np.ndarray) -> np.ndarray:
    """A card as the model's input tensor (3, H, W): portrait, whole card."""
    h, w = image_bgr.shape[:2]
    if w > h:
        image_bgr = cv2.rotate(image_bgr, cv2.ROTATE_90_CLOCKWISE)
    small = cv2.resize(image_bgr, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    return ((rgb - _MEAN) / _STD).transpose(2, 0, 1)


def _upright(image_bgr: np.ndarray) -> np.ndarray:
    h, w = image_bgr.shape[:2]
    return cv2.rotate(image_bgr, cv2.ROTATE_90_CLOCKWISE) if w > h else image_bgr


def _hash_vector(image_bgr: np.ndarray) -> np.ndarray:
    """Structure and colour as one unit vector.

    The dHash bits become +-1 and are scaled so their dot product against
    another card's bits is exactly match.py's structural similarity on the same
    scale; the hue histogram is L2-normalised so its dot product is the colour
    agreement. Each half is then weighted as match.py weights them, which makes
    the index's plain dot product the combined score rather than an
    approximation of it.
    """
    img = _upright(image_bgr)
    bits = np.frombuffer(
        np.binary_repr(dhash(img), width=_HASH_BITS).encode("ascii"), np.uint8
    ).astype(np.float32) - ord("0")
    structure = (bits * 2.0 - 1.0) / np.sqrt(_HASH_BITS)

    hue = hue_signature(img)
    n = float(np.linalg.norm(hue))
    hue = hue / n if n > 0 else hue

    v = np.concatenate([structure * _W_STRUCTURE, hue * _W_COLOUR]).astype(np.float32)
    return v / (np.linalg.norm(v) + 1e-9)


def embed_batch(images: list[np.ndarray]) -> np.ndarray:
    """L2-normalised embeddings, one row per image.

    DINOv2 rows are the class token and the mean of the patch tokens side by
    side: the class token carries the card's overall identity, the patch mean
    its layout, and retrieval on the pair beat either alone on renders of the
    same artwork in different printings.
    """
    if not images:
        return np.zeros((0, dims()), np.float32)
    if backend() == "hash":
        return np.stack([_hash_vector(i) for i in images]).astype(np.float32)
    x = np.stack([prepare(i) for i in images]).astype(np.float32)
    out = _get_session().run(None, {"pixel_values": x})[0]
    cls = out[:, 0, :]
    patches = out[:, 1:, :].mean(axis=1)
    cls = cls / (np.linalg.norm(cls, axis=1, keepdims=True) + 1e-9)
    patches = patches / (np.linalg.norm(patches, axis=1, keepdims=True) + 1e-9)
    v = np.concatenate([cls, patches], axis=1)
    return (v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)).astype(np.float32)


def embed(image_bgr: np.ndarray) -> np.ndarray:
    return embed_batch([image_bgr])[0]
