#!/usr/bin/env python3
"""How well does image recognition find the right card, on real scans?

Uses every stored scan whose identification was confirmed against a catalogue
(storage/<scanId>/front.jpg + the scan record in data/grailcard.db): flattens
the photo with the same detector the service uses, embeds it, searches the
index within the card's game, and reports:

  card     the right CARD ranked first (One Piece: the same number, any printing)
  printing the exact printing the scan was stored under ranked first

Printing is reported but not trusted as ground truth: a One Piece scan is
stored under its base number even when the printing picker chose an alternate
art for the price, so a "printing miss" is often the picture being right.

It then sweeps score and margin thresholds and prints, for each, how many scans
the picture would name on its own and how many of those it gets wrong — the
number that must stay at zero.

  vision/.venv/bin/python vision/scripts/eval_index.py [--games pokemon,onepiece]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
VISION = os.path.dirname(HERE)
BACKEND = os.path.dirname(VISION)
sys.path.insert(0, VISION)

from app.pipeline import cardindex, embed  # noqa: E402
from app.pipeline.cardindex import card_key  # noqa: E402
from app.pipeline.report import run_pipeline  # noqa: E402


def flattened(path: str) -> np.ndarray | None:
    img = cv2.imread(path)
    if img is None:
        return None
    rep = run_pipeline(img, include_images=True, read_text=False)
    b64 = rep.get("warpedImageB64")
    if not b64:
        return None
    return cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), cv2.IMREAD_COLOR)


def base_id(card_id: str) -> str:
    return re.sub(r"_p\d+$", "", card_id or "")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", default="")
    args = ap.parse_args()
    wanted = {g for g in args.games.split(",") if g}

    index = cardindex.load()
    if index is None:
        sys.exit("no index built yet")
    games_in_index = {m.get("game") for m in index.meta}
    bases_in_index = {base_id(m["cardId"]) for m in index.meta}

    db = sqlite3.connect(os.path.join(BACKEND, "data", "grailcard.db"))
    results = []
    skipped = defaultdict(int)
    for scan_id, record in db.execute("select id, record from scans").fetchall():
        rec = json.loads(record)
        ident = rec.get("identification") or {}
        card_id, game = ident.get("cardId"), ident.get("game")
        if not card_id or card_id in ("llm", "described", "sealed") or ident.get("printingConfirmed") is False:
            continue
        if game not in games_in_index or (wanted and game not in wanted):
            continue
        photo = os.path.join(BACKEND, "storage", scan_id, "front.jpg")
        if not os.path.exists(photo):
            skipped["no photo"] += 1
            continue
        if base_id(card_id) not in bases_in_index:
            skipped["card not in index"] += 1
            continue
        card = flattened(photo)
        if card is None:
            skipped["no card found in photo"] += 1
            continue
        hits = index.search(embed.embed(card), k=12, games={game})
        if not hits:
            continue
        top = hits[0]
        rival = next((h for h in hits[1:] if card_key(h) != card_key(top)), None)
        results.append({
            "game": game, "slab": bool(rec.get("slab")), "truth": card_id, "truthName": ident.get("name"),
            "top": top["cardId"], "topName": top.get("name"), "score": top["score"],
            "margin": round(top["score"] - rival["score"], 4) if rival else 1.0,
            "card": base_id(top["cardId"]) == base_id(card_id),
            "printing": top["cardId"] == card_id,
            "cardTop5": base_id(card_id) in {base_id(h["cardId"]) for h in hits[:5]},
        })

    for key, n in skipped.items():
        print(f"skipped: {n} {key}")
    groups = defaultdict(list)
    for r in results:
        groups[(r["game"], "slab" if r["slab"] else "raw")].append(r)
    print()
    for (game, kind), rs in sorted(groups.items()):
        n = len(rs)
        print(f"{game:9} {kind:4} scans {n:3}  card top-1 {sum(r['card'] for r in rs) / n:5.0%}  "
              f"card top-5 {sum(r['cardTop5'] for r in rs) / n:5.0%}  exact printing {sum(r['printing'] for r in rs) / n:5.0%}")

    print("\nthreshold sweep (card-level). named = picture names the card alone; wrong must be 0")
    for min_score in (0.6, 0.65, 0.7, 0.75, 0.8):
        for min_margin in (0.0, 0.03, 0.05, 0.08, 0.12):
            named = [r for r in results if r["score"] >= min_score and r["margin"] >= min_margin]
            wrong = [r for r in named if not r["card"]]
            print(f"  score>={min_score:.2f} margin>={min_margin:.2f}: named {len(named):3}/{len(results)}  wrong {len(wrong)}")

    print("\nmisses (card level):")
    for r in results:
        if not r["card"]:
            print(f"  {r['game']} {'slab' if r['slab'] else 'raw '} truth {r['truth']} {r['truthName']!r} -> "
                  f"{r['top']} {r['topName']!r} score {r['score']} margin {r['margin']}")


if __name__ == "__main__":
    main()
