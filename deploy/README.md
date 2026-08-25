# Deploying the backend

Three scripts, in order. Each is safe to re-run.

```bash
bash deploy/setup.sh                                   # runtimes, deps, venv
bash deploy/services.sh                                # systemd units, start
bash deploy/web.sh grail.duckdns.org you@example.com   # nginx + TLS
```

Before you start: a 2 GB box, `.env` filled in, and DNS already pointing at the
instance. `setup.sh` adds 2 GB of swap — an OCR model on a 2 GB box has no slack,
and swap is the difference between a slow scan and an OOM kill.

## Redeploying after a change

```bash
git pull && npm install --omit=dev && sudo systemctl restart grail-api
```

Only touch `grail-vision` when something under `vision/` changed — restarting it
throws away the loaded OCR model and the next scan pays to reload it.

## When something is wrong

```bash
journalctl -u grail-api    -n 50 --no-pager
journalctl -u grail-vision -n 50 --no-pager
systemctl status grail-api grail-vision
```

A scan returning 502 with nothing in the API log is almost always vision being
OOM-killed: `journalctl -u grail-vision | grep -i kill`. The unit caps it at
1200M so that failure stays contained rather than taking sshd down with it.

## Ports

Only 22, 80 and 443 should be open in the security group. The API (8180) and
vision (8100) bind to 127.0.0.1 and are reached through nginx — nothing outside
the box talks to them directly.
