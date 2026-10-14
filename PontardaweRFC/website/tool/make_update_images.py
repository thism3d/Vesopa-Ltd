"""Publish the club's update pictures (content/updates.json) to public/img/ig/.

    python PontardaweRFC/website/tool/make_update_images.py

Each update names its crops from content/images/instagram/ (made by
tool/crop_instagram.py). A carousel post sits in black bars on the phone;
"trim": true cuts those off. Each picture is written as .webp and .jpg, at
most 960px wide, plus a 480px .webp for cards, and its size and alt text go to content/images-ig.json for
the pages. The output is committed, so the server needs no image tools.
"""
import json
import pathlib

from PIL import Image

SITE = pathlib.Path(__file__).resolve().parents[1]
CROPS = SITE / "content" / "images" / "instagram"
OUT = SITE / "public" / "img" / "ig"
WIDTH = 960


def trim_dark(im, limit=18):
    """Cut rows of near-black (a carousel's letterbox) off the top and bottom."""
    g = im.convert("L")
    w, h = g.size
    px = g.load()
    xs = range(0, w, 8)

    def dark(y):
        return max(px[x, y] for x in xs) <= limit

    top = 0
    while top < h - 1 and dark(top):
        top += 1
    bottom = h - 1
    while bottom > top and dark(bottom):
        bottom -= 1
    return im.crop((0, top, w, bottom + 1))


def main():
    updates = json.loads((SITE / "content" / "updates.json").read_text(encoding="utf-8"))["updates"]
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {}
    for u in updates:
        for img in u.get("images", []):
            im = Image.open(CROPS / img["crop"]).convert("RGB")
            if img.get("trim"):
                im = trim_dark(im)
            if im.width > WIDTH:
                im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
            im.save(OUT / f"{img['name']}.webp", quality=76, method=6)
            im.save(OUT / f"{img['name']}.jpg", quality=78, optimize=True, progressive=True)
            # The size a card needs on a phone or in a grid of three.
            sm = im.resize((480, round(im.height * 480 / im.width)), Image.LANCZOS)
            sm.save(OUT / f"{img['name']}-480.webp", quality=74, method=6)
            meta[f"ig/{img['name']}"] = {"alt": img["alt"], "w": im.width, "h": im.height}
    (SITE / "content" / "images-ig.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(f"{len(meta)} pictures -> public/img/ig/")


if __name__ == "__main__":
    main()
