---
title: GrailCard Vision
emoji: 🃏
colorFrom: gray
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
short_description: Card detection, centering measurement and label OCR
---

# GrailCard Vision

The computer-vision half of GrailCard. Takes a photograph of a trading card and
returns measurements — it does not price anything and does not call out to any
paid service.

The frontmatter above is what Hugging Face Spaces reads: `sdk: docker` makes it
build the `Dockerfile` in this directory, and `app_port: 7860` must match the
port the container listens on.

## What it does

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | liveness probe |
| `POST /analyze` | detect the card, gate photo quality, measure centering, find surface marks, read card text and any grading-slab label |
| `POST /similarity` | perceptual-hash comparison against candidate catalogue images |

## Why it is a container

OpenCV plus the ONNX OCR runtime is roughly 300 MB of wheels — too large for a
serverless function, and the resident models alone hold ~350 MB at run time. A
512 MB instance is killed mid-scan, which is why this runs somewhere with real
memory rather than alongside the API.

## Running locally

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --port 8100 --reload
```

From the repo root, `npm run dev:vision` does the same thing.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7860` | listen port — Spaces requires 7860 |
| `MAX_INPUT_PX` | `2000` | longest input edge; larger photos are downscaled before processing. Raise it where there is memory to spare |
| `OMP_NUM_THREADS` | `2` | set to `1` on fractional-CPU hosts, where extra OpenCV threads only contend |
