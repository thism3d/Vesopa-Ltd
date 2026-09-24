"""
The phone launcher icons, drawn from the same V as the Store art.

    python tool/make_app_icons.py

Flutter's template ships its own blue-and-white F at every size, and the first
build of the Kitchen wore it (2026-09-14). This writes the venue's mark in
their place -- Android legacy tiles, Android adaptive foregrounds, and the iOS
AppIcon set -- from tool/make_store_art.py's `render`, so the launcher icon,
the Store tiles and the msix logo are all the one drawing.

ANDROID DRAWS THE ICON TWO WAYS. Android 7 (API 24-25) shows mipmap-*/
ic_launcher.png as it is, so that one is a rounded tile. Android 8+ ignores it
and composes an *adaptive* icon: a background (the venue colour, from
values/push.xml) under a 108dp foreground, of which the launcher shows only the
middle 72dp in whatever shape the phone likes. The V is sized for that window,
which is why the foreground PNGs look mostly empty.

iOS wants square PNGs with no alpha and masks them itself.

For another venue: change LIME/WHITE/INK in make_store_art.py (or point it at
that venue's shapes) and run both tools.
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw

from make_store_art import LIME, render

HERE = Path(__file__).resolve().parent.parent
RES = HERE / "android" / "app" / "src" / "main" / "res"
IOS = HERE / "ios" / "Runner" / "Assets.xcassets" / "AppIcon.appiconset"

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def rounded(tile, radius_frac=0.18):
    """A legacy launcher tile: the full-bleed mark with its corners rounded."""
    s = tile.width * 4
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * radius_frac), fill=255)
    mask = mask.resize(tile.size, Image.LANCZOS)
    out = Image.new("RGBA", tile.size, (0, 0, 0, 0))
    out.paste(tile, (0, 0), mask)
    return out


def android():
    for name, scale in DENSITIES.items():
        d = RES / f"mipmap-{name}"
        d.mkdir(exist_ok=True)
        rounded(render(int(48 * scale))).save(d / "ic_launcher.png")
        # 108dp canvas, the V sized for the 72dp the launcher shows of it:
        # the mark's 62% of a tile becomes 62% x 72/108 of this canvas.
        render(int(108 * scale), fill=0.62 * 72 / 108, full_bleed=False).save(d / "ic_launcher_foreground.png")

    v26 = RES / "mipmap-anydpi-v26"
    v26.mkdir(exist_ok=True)
    (v26 / "ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- Written by tool/make_app_icons.py. The colour is values/push.xml's. -->\n"
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/brand"/>\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
        "</adaptive-icon>\n",
        encoding="utf-8",
    )


def ios():
    contents = json.loads((IOS / "Contents.json").read_text(encoding="utf-8"))
    done = set()
    for image in contents["images"]:
        filename = image["filename"]
        if filename in done:
            continue
        done.add(filename)
        points = float(image["size"].split("x")[0])
        scale = int(image["scale"].rstrip("x"))
        px = round(points * scale)
        tile = Image.new("RGB", (px, px), LIME)
        tile.paste(render(px), (0, 0))
        tile.save(IOS / filename)


if __name__ == "__main__":
    android()
    ios()
    print("launcher icons written:", RES, "and", IOS)
