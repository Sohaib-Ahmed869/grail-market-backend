import base64
import json
import os

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from .pipeline import run_pipeline
from .pipeline.match import dhash, fetch_image, similarity

app = FastAPI(title="grailcard-vision", version="0.1.0")

# Phone cameras send 12-megapixel photos. Decoded to BGR that is ~36 MB, and
# the pipeline holds several copies at once (the source, the warped card, the
# annotated overlays, then a PNG encode of each). Alongside the OCR models
# already resident, that exceeds a small container and the process is killed
# mid-scan — the caller sees a 502 with no explanation.
#
# Nothing downstream needs that resolution: OCR runs on an 800px-tall crop and
# centering is measured on a fixed 750x1050 canvas. Capping the longest side
# costs no accuracy and cuts both peak memory and CPU time by the square of the
# scale factor. Raise MAX_INPUT_PX on a larger instance.
# DEFAULT OFF. Downscaling is a memory tactic for small containers, and it is
# not free: shrinking a 2048px photo by even 2% lost the collector number off
# the card face, and identification silently fell back to name matching — a
# PSA 10 Umbreon VMAX #215 resolved to the ordinary #95, a ~40x pricing error.
# Only enable it where memory genuinely forces the trade (render.yaml sets it),
# and never below what the OCR needs to read a collector number.
MAX_INPUT_PX = int(os.environ.get("MAX_INPUT_PX", "0"))


def _fit_input(image: np.ndarray, label: str) -> np.ndarray:
    """Downscale so the longest side is at most MAX_INPUT_PX. No-op if smaller."""
    h, w = image.shape[:2]
    longest = max(h, w)
    if MAX_INPUT_PX <= 0 or longest <= MAX_INPUT_PX:
        return image
    scale = MAX_INPUT_PX / longest
    out = cv2.resize(
        image, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA
    )
    print(
        f"[vision] {label}: {w}x{h} -> {out.shape[1]}x{out.shape[0]} "
        f"({(w * h) / 1e6:.1f}MP -> {(out.shape[1] * out.shape[0]) / 1e6:.1f}MP)",
        flush=True,
    )
    return out


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "vision"}


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    kind: str = Form("front"),
    include_images: bool = Form(True),
) -> dict:
    raw = await file.read()
    data = np.frombuffer(raw, np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=422, detail="could not decode image")
    image = _fit_input(image, kind)
    # free the encoded bytes before the pipeline allocates its own copies
    del raw, data
    # card text (name, collector number) is printed on the front only
    return run_pipeline(image, include_images=include_images, read_text=kind == "front")


@app.post("/similarity")
async def visual_similarity(
    urls: str = Form(...),  # JSON array of candidate image URLs
    file: UploadFile | None = File(None),
    imageB64: str | None = Form(None),
) -> dict:
    """Score a photographed card against candidate catalogue images.

    Takes the card as a FILE. It used to take base64 in a form field, and
    starlette caps a non-file field at 1 MB — a warped card is several times
    that, so every request was rejected as a malformed multipart body before
    reaching this function. No traceback, no log line beyond "400", and the
    visual match silently never ran. That left printing selection to text alone,
    which is the one thing text usually cannot answer.

    The base64 field is still accepted for callers that send a small image.
    """
    if file is not None:
        raw = np.frombuffer(await file.read(), np.uint8)
    elif imageB64:
        raw = np.frombuffer(base64.b64decode(imageB64), np.uint8)
    else:
        raise HTTPException(status_code=422, detail="send the card as `file`")
    img = cv2.imdecode(raw, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=422, detail="could not decode image")
    img = _fit_input(img, "similarity")
    reference = dhash(img)

    scores = []
    for url in json.loads(urls)[:6]:
        candidate = fetch_image(url)
        scores.append(
            {
                "url": url,
                "similarity": similarity(reference, dhash(candidate))
                if candidate is not None
                else None,
            }
        )
    return {"scores": scores}
