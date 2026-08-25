#!/usr/bin/env bash
# Install and start the two systemd units. Safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(whoami)"
echo "==> installing units for $USER_NAME at $REPO"

sudo tee /etc/systemd/system/grail-vision.service >/dev/null <<UNIT
[Unit]
Description=GrailCard vision (OCR + computer vision)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$REPO
# One worker on purpose: the OCR model is ~350 MB resident and a second worker
# would double that on a box sized for one.
ExecStart=$REPO/vision/.venv/bin/python -m uvicorn app.main:app --app-dir vision --host 127.0.0.1 --port 8100
Restart=always
RestartSec=3
# Bound below the box's RAM so a runaway request is killed rather than taking
# the whole instance, including the API and sshd, down with it.
MemoryMax=1200M

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/grail-api.service >/dev/null <<UNIT
[Unit]
Description=GrailCard API
After=network-online.target grail-vision.service
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$REPO
EnvironmentFile=$REPO/.env
ExecStart=$REPO/node_modules/.bin/tsx src/main.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now grail-vision grail-api
sleep 8
echo
systemctl --no-pager --lines=0 status grail-vision grail-api | grep -E "●|Active:" || true
echo
echo "==> health"
curl -fsS --max-time 20 http://127.0.0.1:8100/health >/dev/null && echo "    vision 8100 ok" || echo "    vision 8100 FAILED — journalctl -u grail-vision -n 40"
curl -fsS --max-time 30 http://127.0.0.1:8180/market/fx >/dev/null && echo "    api    8180 ok" || echo "    api    8180 FAILED — journalctl -u grail-api -n 40"
echo
echo "Next:  bash deploy/web.sh your-domain.duckdns.org you@email.com"
