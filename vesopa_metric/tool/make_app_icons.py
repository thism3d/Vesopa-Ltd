"""
Launcher icons for every build, from Metric Group's own mark.

    python tool/make_app_icons.py

The mark is Metric's site icon from metricgroup.co.uk (assets/brand/
metric-icon.png, navy and green on transparent). Flutter's template ships
its own blue F at every size; this writes Metric's mark in its place:

  * Android: legacy mipmap-*/ic_launcher.png (white rounded tile) and an
    adaptive icon (white background, the mark inside the 72dp safe window)
  * iOS: the AppIcon set, square and opaque (iOS masks it itself)
  * Windows: runner/resources/app_icon.ico
  * web: done by hand in web/ (icons/, favicon.png)
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent.parent
MARK = Image.open(HERE / "assets" / "brand" / "metric-icon.png").convert("RGBA")
RES = HERE / "android" / "app" / "src" / "main" / "res"
IOS = HERE / "ios" / "Runner" / "Assets.xcassets" / "AppIcon.appiconset"
WIN = HERE / "windows" / "runner" / "resources" / "app_icon.ico"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def tile(size, pad=0.14, radius=None, bg=(255, 255, 255, 255)):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if radius is None:
        im.paste(bg, (0, 0, size, size))
    else:
        ImageDraw.Draw(im).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * radius), fill=bg)
    inner = int(size * (1 - 2 * pad))
    m = MARK.resize((inner, inner), Image.LANCZOS)
    im.alpha_composite(m, ((size - inner) // 2, (size - inner) // 2))
    return im


def android():
    for name, k in DENSITIES.items():
        d = RES / f"mipmap-{name}"
        d.mkdir(parents=True, exist_ok=True)
        tile(int(48 * k), pad=0.12, radius=0.2).save(d / "ic_launcher.png")
        # Adaptive foreground: 108dp, of which the middle 72dp shows.
        fg = Image.new("RGBA", (int(108 * k),) * 2, (0, 0, 0, 0))
        inner = int(60 * k)
        fg.alpha_composite(MARK.resize((inner, inner), Image.LANCZOS), ((fg.width - inner) // 2,) * 2)
        fg.save(d / "ic_launcher_foreground.png")
    v26 = RES / "mipmap-anydpi-v26"
    v26.mkdir(parents=True, exist_ok=True)
    (v26 / "ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@android:color/white"/>\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
        '</adaptive-icon>\n'
    )


def ios():
    contents = json.loads((IOS / "Contents.json").read_text())
    for img in contents["images"]:
        f = img.get("filename")
        if not f:
            continue
        size = int(float(img["size"].split("x")[0]) * int(img["scale"].rstrip("x")))
        tile(size, pad=0.14).convert("RGB").save(IOS / f)


def windows():
    tile(256, pad=0.06, radius=0.18).save(WIN, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    android()
    ios()
    windows()
    print("icons written")
