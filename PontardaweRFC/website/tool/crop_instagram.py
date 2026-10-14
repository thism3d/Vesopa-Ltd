"""Crop the club's Instagram/Facebook posts out of phone screenshots.

    python tool/crop_instagram.py            # PontardaweRFC/InstagramScreenshots -> content/images/instagram/

A post's picture fills the phone's width between the app's white bands, so
each screenshot is scanned for full-width runs of picture rows and the
largest is that screenshot's post. Writes crops.json: each crop, the screenshot it came from, and its
place in the feed (first screenshot = newest post).
"""
import json
import pathlib
import sys

from PIL import Image

HERE = pathlib.Path(__file__).resolve().parents[1]
SRC = HERE.parents[0] / "InstagramScreenshots"
OUT = HERE / "content" / "images" / "instagram"

# Screenshots the edge finder cannot read, with the post's rows set by eye:
# a white poster on Instagram's white feed, a dark Facebook viewer, and a
# reel whose screenshot shows only its description (None: no picture).
MANUAL = {
    "Screenshot_2026-10-15-00-20-54-500_com.facebook.katana.jpg": (614, 1690),
    "Screenshot_2026-10-15-01-15-11-898_com.instagram.android.jpg": None,
    "Screenshot_2026-10-15-01-16-51-284_com.instagram.android.jpg": (392, 1746),
}


def picture_rows(im):
    """True for each row that is part of a picture rather than the white app."""
    g = im.convert("L")
    w, h = g.size
    px = g.load()
    xs = list(range(0, w, 12))
    edge = [x for x in xs if x < 40 or x > w - 40]
    rows = []
    for y in range(h):
        vals = [px[x, y] for x in xs]
        ink = sum(1 for v in vals if v < 238) / len(vals)
        edges = sum(1 for x in edge if px[x, y] < 245) / len(edge)
        # A text line has ink in the middle but white margins; a picture
        # reaches both edges of the phone.
        rows.append(ink > 0.25 and edges > 0.5)
    return rows


def bands(rows, min_h=260, gap=6):
    out, start, miss = [], None, 0
    for y, on in enumerate(rows + [False] * (gap + 1)):
        if on:
            if start is None:
                start = y
            miss = 0
        elif start is not None:
            miss += 1
            if miss > gap:
                end = y - miss
                if end - start >= min_h:
                    out.append((start, end))
                start, miss = None, 0
    return out


def ahash(im, n=12):
    g = im.convert("L").resize((n, n))
    v = list(g.getdata())  # noqa
    m = sum(v) / len(v)
    return [1 if p > m else 0 for p in v]


def close(a, b):
    return sum(x != y for x, y in zip(a, b)) <= 14


def main():
    """One post per screenshot: each was taken to show one post, so its
    largest picture is that post (the owner, 2026-10-14)."""
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("post-*.jpg"):
        old.unlink()
    shots = sorted(p for p in SRC.glob("*.jpg"))
    kept = []
    for order, shot in enumerate(shots):
        im = Image.open(shot).convert("RGB")
        w, h = im.size
        if shot.name in MANUAL:
            if MANUAL[shot.name] is None:
                continue
            (a, b), whole = MANUAL[shot.name], True
        elif w > h:  # already a crop (the owner's example)
            a, b, whole = 0, h, True
        else:
            top, bottom = int(h * 0.105), int(h * 0.944)  # title bar + nav bar (row 2209 of 2340)
            found = [(max(x, top), min(y, bottom)) for x, y in bands(picture_rows(im)) if y > top and x < bottom]
            if not found:
                print("no picture found in", shot.name)
                continue
            a, b = max(found, key=lambda r: r[1] - r[0])
            whole = a > top + 4 and b < bottom - 6
        name = f"post-{order + 1:03d}.jpg"
        im.crop((0, a, w, b)).save(OUT / name, quality=86)
        kept.append({"file": name, "source": shot.name, "order": order, "whole": whole,
                     "width": w, "height": b - a, "top": a, "bottom": b})
    (OUT / "crops.json").write_text(json.dumps(kept, indent=1), encoding="utf-8")
    print(f"{len(shots)} screenshots -> {len(kept)} posts ({sum(k['whole'] for k in kept)} whole)")


if __name__ == "__main__":
    sys.exit(main())
