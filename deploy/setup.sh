#!/usr/bin/env bash
# One-time setup for an Ubuntu box. Safe to re-run.
#
#   bash deploy/setup.sh
#
# Installs the two runtimes, the OS libraries OpenCV needs, and the Python venv.
# Does not touch nginx or TLS — that is deploy/web.sh, which needs a domain.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
echo "==> repo: $REPO"

# A 2 GB box running an OCR model has no slack. Swap costs nothing when unused
# and is the difference between a slow scan and an OOM-killed process.
if ! swapon --show | grep -q .; then
  echo "==> adding 2G swap"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> apt"
sudo apt-get update -qq
# libgl1 and libglib2.0-0 are OpenCV's runtime deps. Without them `import cv2`
# fails at startup with an error that names neither OpenCV nor the missing lib.
sudo apt-get install -y -qq \
  python3 python3-venv python3-pip \
  libgl1 libglib2.0-0 \
  nginx curl ca-certificates git

if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  echo "==> node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
echo "    node $(node -v), python $(python3 --version | cut -d' ' -f2)"

echo "==> npm install"
npm install --omit=dev --no-audit --no-fund

echo "==> python venv"
python3 -m venv vision/.venv
vision/.venv/bin/pip install -q --upgrade pip
vision/.venv/bin/pip install -q -r vision/requirements.txt

echo "==> checking .env"
if [ ! -f .env ]; then
  echo "    MISSING .env — copy .env.example and fill it in first" >&2
  exit 1
fi
grep -q '^VISION_URL=' .env || echo 'VISION_URL=http://127.0.0.1:8100' >> .env
grep -q '^PORT='       .env || echo 'PORT=8180'                        >> .env

echo "==> warming the OCR model (first load downloads it)"
vision/.venv/bin/python - <<'PY'
from rapidocr_onnxruntime import RapidOCR
RapidOCR()
print("    OCR model ready")
PY

echo
echo "Done. Next:  bash deploy/services.sh"
