"""Card image embeddings — the recognition half of identification.

Everything else in this service reads TEXT off a card and hands names and
numbers to catalogues. That fails on exactly the cards people care about: holo
glare across the collector line, Japanese print, stylised fonts, and any card
whose number is on the back. A picture of the card is the one thing every scan
always has.

Model: DINOv2-small (Meta, Apache-2.0), run through onnxruntime — the same
runtime RapidOCR already uses, so no PyTorch. DINOv2 is trained for instance
retrieval rather than captioning, which is the question asked here ("which of
these 50,000 renders is THIS card"), and at 22M parameters it runs at ~45 ms a
card on four CPU threads.

The whole card is resized, never centre-cropped: the name and the collector
number live at the top and bottom edges, and a square crop would cut both off.
308x224 keeps the card's 88:63 shape on the model's 14-pixel patch grid.
"""

from __future__ import annotations

import os
import threading

import cv2
import numpy as np

MODEL_DIR = os.environ.get(
    "EMBED_MODEL_DIR",
    os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "models", "dinov2-small")),
)
MODEL_FILE = os.environ.get("EMBED_MODEL_FILE", "model.onnx")
HEIGHT, WIDTH = 308, 224
_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
_STD = np.array([0.229, 0.224, 0.225], np.float32)

_session = None
_lock = threading.Lock()


def model_path() -> str:
    return os.path.join(MODEL_DIR, MODEL_FILE)


def available() -> bool:
    return os.path.exists(model_path())


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


def embed_batch(images: list[np.ndarray]) -> np.ndarray:
    """L2-normalised embeddings, one row per image.

    Each row is the class token and the mean of the patch tokens side by side:
    the class token carries the card's overall identity, the patch mean its
    layout, and retrieval on the pair beat either alone on renders of the same
    artwork in different printings.
    """
    if not images:
        return np.zeros((0, 768), np.float32)
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
