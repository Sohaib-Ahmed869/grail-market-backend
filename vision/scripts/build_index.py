#!/usr/bin/env python3
"""Build the card image index (vision/index/) from free catalogue renders.

Run from grail-market-backend:

  vision/.venv/bin/python vision/scripts/build_index.py --sources pokemon,onepiece
  vision/.venv/bin/python vision/scripts/build_index.py --sources all --workers 4
  vision/.venv/bin/python vision/scripts/build_index.py --merge-only

Each source is built into index/shards/<source>.npy + .jsonl and skipped on a
re-run unless --force, so an interrupted build resumes at the next source.
Pictures are downloaded, embedded and thrown away: only the vectors and one
metadata row per card are kept. Every source is free and needs no key.

It is a one-off job, not a schedule: run it after deploy, and again when a new
set releases. See vision/app/pipeline/cardindex.py for what uses it.
"""

from __future__ import annotations

import argparse
import gzip
import importlib.util
import io
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import get_context

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
VISION = os.path.dirname(HERE)
INDEX = os.environ.get("CARD_INDEX_DIR", os.path.join(VISION, "index"))
SHARDS = os.path.join(INDEX, "shards")
UA = {"User-Agent": "GrailMarket-card-index/1.0", "Accept": "*/*"}

def dims() -> int:
    """Vector width, from whichever embedder EMBED_BACKEND selects — the two
    backends produce different lengths and must not land in one index."""
    return _load_embed_module().dims()


def get(url: str, timeout: float = 60) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_json(url: str):
    return json.loads(get(url, timeout=180))


# ---- sources -----------------------------------------------------------------
# Each yields (url to embed, metadata row). `cardId` is in the backend's own
# format for that game, so a match needs no translation to be looked up.

def src_pokemon():
    sets = {s["id"]: s.get("name") for s in get_json("https://api.tcgdex.net/v2/en/sets")}
    for c in get_json("https://api.tcgdex.net/v2/en/cards"):
        if not c.get("image"):
            continue
        set_id = c["id"].rsplit("-", 1)[0]
        yield c["image"] + "/low.webp", {
            "game": "pokemon", "cardId": c["id"], "name": c.get("name"),
            "setId": set_id, "setName": sets.get(set_id), "number": c.get("localId"),
            "imageUrl": c["image"] + "/low.png",
        }


def src_pokemon_ja():
    sets = {s["id"]: s.get("name") for s in get_json("https://api.tcgdex.net/v2/ja/sets")}
    for c in get_json("https://api.tcgdex.net/v2/ja/cards"):
        if not c.get("image"):
            continue
        set_id = c["id"].rsplit("-", 1)[0]
        yield c["image"] + "/low.webp", {
            "game": "pokemon", "language": "ja", "cardId": f"tcgdex-ja:{c['id']}", "name": c.get("name"),
            "setId": set_id, "setName": sets.get(set_id), "number": c.get("localId"),
            "imageUrl": c["image"] + "/low.png",
        }


def src_onepiece():
    for endpoint in ("allSetCards", "allSTCards"):
        for c in get_json(f"https://optcgapi.com/api/{endpoint}/"):
            img = c.get("card_image")
            image_id = c.get("card_image_id") or c.get("card_set_id")
            if not img or not image_id:
                continue
            code = c.get("card_set_id") or ""
            yield img, {
                "game": "onepiece", "cardId": f"optcg-{image_id}", "name": c.get("card_name"),
                "setId": code.split("-")[0] or None, "setName": c.get("set_name"), "number": code or None,
                "imageUrl": img,
            }


def src_yugioh():
    # One artwork is shared by every printing of a Yu-Gi-Oh card, so a match
    # names the card, never the printing: the set code still has to be read.
    for c in get_json("https://db.ygoprodeck.com/api/v7/cardinfo.php")["data"]:
        for im in c.get("card_images", []):
            yield im["image_url_small"], {
                "game": "yugioh", "cardId": f"ygo-{c['id']}", "imageId": im["id"], "name": c.get("name"),
                "setId": None, "setName": None, "number": None, "imageUrl": im["image_url"],
            }


def src_lorcana():
    for s in get_json("https://api.lorcast.com/v0/sets")["results"]:
        cards = get_json(f"https://api.lorcast.com/v0/sets/{s['code']}/cards")
        time.sleep(0.15)  # Lorcast asks for gentle use
        for c in cards if isinstance(cards, list) else cards.get("results", []):
            img = ((c.get("image_uris") or {}).get("digital") or {}).get("small")
            if not img:
                continue
            name = c.get("name") or ""
            if c.get("version"):
                name = f"{name} - {c['version']}"
            yield img, {
                "game": "lorcana", "cardId": f"lorcana-{c['id']}", "name": name,
                "setId": s["code"], "setName": s.get("name"), "number": c.get("collector_number"),
                "imageUrl": img,
            }


def src_mtg():
    listing = get_json("https://api.scryfall.com/bulk-data")
    uri = next(x["jsonl_download_uri"] for x in listing["data"] if x["type"] == "unique_artwork")
    for line in gzip.decompress(get(uri, timeout=900)).splitlines():
        if not line.strip():
            continue
        c = json.loads(line)
        if c.get("digital") or c.get("layout") in ("art_series", "token", "double_faced_token", "emblem"):
            continue
        uris = c.get("image_uris") or ((c.get("card_faces") or [{}])[0].get("image_uris")) or {}
        img = uris.get("small")
        if not img:
            continue
        yield img, {
            "game": "mtg", "cardId": f"scryfall-{c['id']}", "name": c.get("name"),
            "setId": c.get("set"), "setName": c.get("set_name"), "number": c.get("collector_number"),
            "imageUrl": uris.get("normal") or img,
        }


SOURCES = {
    "pokemon": src_pokemon,
    "onepiece": src_onepiece,
    "lorcana": src_lorcana,
    "yugioh": src_yugioh,
    "pokemon-ja": src_pokemon_ja,
    "mtg": src_mtg,
}


# ---- workers -----------------------------------------------------------------

def decode(data: bytes) -> np.ndarray | None:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is not None:
        return img
    try:  # AVIF (Lorcast) and anything else OpenCV was built without
        from PIL import Image

        im = Image.open(io.BytesIO(data)).convert("RGB")
        return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
    except Exception:
        return None


_embed_mod = None


def _load_embed_module():
    """The embed module by file path, so a worker does not import the whole
    pipeline package — that would load the OCR models into every process.

    embed.py falls back to a path import of match.py when it is loaded this
    way, because a file-path module has no package for `from .match` to
    resolve against."""
    global _embed_mod
    if _embed_mod is None:
        spec = importlib.util.spec_from_file_location("embed", os.path.join(VISION, "app", "pipeline", "embed.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _embed_mod = mod
    return _embed_mod


def _load_embedder():
    return _load_embed_module().embed_batch


def _work(chunk):
    embed_batch = _load_embedder()

    def fetch(item):
        url, meta = item
        for attempt in range(3):
            try:
                img = decode(get(url, timeout=30))
                return img, meta
            except Exception:
                time.sleep(1 + attempt)
        return None, meta

    with ThreadPoolExecutor(12) as ex:
        got = [(img, m) for img, m in ex.map(fetch, chunk) if img is not None]
    vecs = [embed_batch([g[0] for g in got[i:i + 16]]) for i in range(0, len(got), 16)]
    v = np.concatenate(vecs) if vecs else np.zeros((0, dims()), np.float32)
    return v.astype(np.float16), [g[1] for g in got], len(chunk) - len(got)


def build_source(name: str, workers: int, limit: int | None, force: bool) -> None:
    vec_path = os.path.join(SHARDS, f"{name}.npy")
    meta_path = os.path.join(SHARDS, f"{name}.jsonl")
    if os.path.exists(vec_path) and os.path.exists(meta_path) and not force:
        print(f"[{name}] already built, skipping (use --force to rebuild)", flush=True)
        return
    t0 = time.time()
    items, seen = [], set()
    for url, meta in SOURCES[name]():
        key = (meta["cardId"], meta.get("imageId"))
        if key in seen:
            continue
        seen.add(key)
        items.append((url, meta))
        if limit and len(items) >= limit:
            break
    print(f"[{name}] {len(items)} images to embed", flush=True)

    chunks = [items[i:i + 192] for i in range(0, len(items), 192)]
    vecs, metas, missed, done = [], [], 0, 0
    with get_context("spawn").Pool(workers) as pool:
        for v, m, miss in pool.imap(_work, chunks):
            vecs.append(v)
            metas.extend(m)
            missed += miss
            done += len(m) + miss
            rate = done / max(1e-6, time.time() - t0)
            print(f"[{name}] {done}/{len(items)}  {rate:.0f} img/s  {missed} failed", flush=True)

    V = np.concatenate(vecs) if vecs else np.zeros((0, dims()), np.float16)
    np.save(vec_path + ".tmp.npy", V)
    os.replace(vec_path + ".tmp.npy", vec_path)
    with open(meta_path + ".tmp", "w", encoding="utf-8") as f:
        for m in metas:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
    os.replace(meta_path + ".tmp", meta_path)
    print(f"[{name}] done: {len(metas)} embedded, {missed} failed, {time.time() - t0:.0f}s", flush=True)


def merge() -> None:
    vecs, metas = [], []
    for name in SOURCES:
        vp, mp = os.path.join(SHARDS, f"{name}.npy"), os.path.join(SHARDS, f"{name}.jsonl")
        if not (os.path.exists(vp) and os.path.exists(mp)):
            continue
        v = np.load(vp)
        with open(mp, encoding="utf-8") as f:
            m = [json.loads(line) for line in f if line.strip()]
        n = min(len(m), len(v))
        vecs.append(v[:n])
        metas.extend(m[:n])
        print(f"[merge] {name}: {n}", flush=True)
    V = np.concatenate(vecs).astype(np.float16) if vecs else np.zeros((0, dims()), np.float16)
    tmp = os.path.join(INDEX, "vectors.tmp.npy")
    np.save(tmp, V)
    os.replace(tmp, os.path.join(INDEX, "vectors.npy"))
    with open(os.path.join(INDEX, "meta.jsonl.tmp"), "w", encoding="utf-8") as f:
        for m in metas:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
    os.replace(os.path.join(INDEX, "meta.jsonl.tmp"), os.path.join(INDEX, "meta.jsonl"))
    with open(os.path.join(INDEX, "manifest.json"), "w") as f:
        json.dump({
            "model": "dinov2-small", "dims": int(V.shape[1]), "rows": len(metas),
            "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }, f)
    print(f"[merge] index: {len(metas)} cards", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", default="pokemon,onepiece,lorcana,yugioh")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--merge-only", action="store_true")
    args = ap.parse_args()
    os.makedirs(SHARDS, exist_ok=True)
    os.environ.setdefault("EMBED_THREADS", "3")
    if not args.merge_only:
        names = list(SOURCES) if args.sources == "all" else [s.strip() for s in args.sources.split(",") if s.strip()]
        for name in names:
            if name not in SOURCES:
                sys.exit(f"unknown source {name}; choose from {', '.join(SOURCES)}")
            build_source(name, args.workers, args.limit or None, args.force)
    merge()


if __name__ == "__main__":
    main()
