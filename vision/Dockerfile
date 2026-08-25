# Vision service — OpenCV + RapidOCR. Too large for serverless (≈300MB of
# wheels), so it ships as a container. Runs unchanged on Render, Fly, Cloud Run
# and Hugging Face Spaces; only $PORT differs (HF Spaces requires 7860).
FROM python:3.12-slim

# opencv needs libGL + glib even in headless mode; curl is for the healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# NOTE: paths are relative to the REPO ROOT, not services/vision. Hosted
# builders default the context to the repo root and only expose the
# Dockerfile path, so root-relative COPY is the portable choice.
# deps first so the layer caches across code edits
COPY services/vision/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/vision/app ./app

# RapidOCR downloads its ONNX models on first use; warm them at BUILD time so
# the first real scan isn't paying for the download on a cold container.
RUN python -c "from rapidocr_onnxruntime import RapidOCR; RapidOCR()" || true

ENV PORT=7860 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=2
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD curl -fsS http://localhost:${PORT}/health || exit 1

CMD ["sh", "-c", "python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
