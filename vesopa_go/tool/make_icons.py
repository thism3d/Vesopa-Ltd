"""Vesopa Go's icon, drawn from the Vesopa V (logo.svg's three shapes), and
every size the stores and launchers ask for.

    python vesopa_go/tool/make_icons.py

The tile is ink (#10130A), so Go is told apart from the lime Vesopa EPOS icon
beside it; the V keeps its lime strokes, its dark stroke turns white to read on
ink, and it breaks out of an orbit at the upper right: on the move, anywhere
in the venue. (Speed lines are Vesopa Express's; Go does not share them.) Drawn 4x and scaled down for clean
edges. Writes the master (store/icon-1024.png), Play's 512 icon, Android's
launcher and adaptive layers, iOS's app icon set and the in-app mark.
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

GO = Path(__file__).resolve().parents[1]
INK = (16, 19, 10)
LIME = (165, 199, 21)
WHITE = (255, 255, 255)
# logo.svg, viewBox 0 0 46.35 33.09
LEFT = [(9.95, 0), (0, 0), (18.01, 33.09), (27.96, 33.09)]
UPPER = [(27.4, 16.54), (37.35, 16.54), (46.35, 0), (36.4, 0)]
LOWER = [(27.4, 16.54), (18.39, 33.09), (28.34, 33.09), (37.35, 16.54)]
W, H = 46.35, 33.09


RING = 0.84     # the V's width, as a share of the group; the orbit is a little smaller, so the V crosses it
GAP = (-62, -14)  # the orbit's opening, degrees clockwise from three o'clock: the V's arm breaks out here
STROKE = 0.042  # the orbit's line, as a share of the group


def mark(size, group=0.70, background=True, glow=True):
    """The icon at `size` px: the V breaking out of its orbit, as one group
    `group` of the tile wide, centred."""
    import math
    s = size * 4
    im = Image.new("RGBA", (s, s), INK + (255,) if background else (0, 0, 0, 0))
    g = s * group
    c = s / 2
    if background and glow:
        halo = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        r = s * 0.40
        ImageDraw.Draw(halo).ellipse((c - r, c - r, c + r, c + r), fill=LIME + (30,))
        im = Image.alpha_composite(im, halo.filter(ImageFilter.GaussianBlur(s * 0.09)))
    d = ImageDraw.Draw(im)
    # The orbit: white, open at the upper right, a lime dot where it ends.
    r = g * 0.43
    w = g * STROKE
    d.arc((c - r, c - r, c + r, c + r), GAP[1], 360 + GAP[0], fill=WHITE + (235,), width=round(w))
    for deg, colour, size_k in ((GAP[1], WHITE + (235,), 1.0), (GAP[0], LIME + (255,), 1.9)):
        mid = r - w / 2
        ex, ey = c + mid * math.cos(math.radians(deg)), c + mid * math.sin(math.radians(deg))
        q = w * size_k / 2
        d.ellipse((ex - q, ey - q, ex + q, ey + q), fill=colour)
    # The V, centred, its upper arm reaching through the opening.
    vw = g * RING
    k = vw / W
    ox, oy = c - vw / 2 + vw * 0.02, c - H * k / 2 + H * k * 0.04
    d.polygon([(ox + x * k, oy + y * k) for x, y in LEFT], fill=LIME)
    d.polygon([(ox + x * k, oy + y * k) for x, y in UPPER], fill=LIME)
    d.polygon([(ox + x * k, oy + y * k) for x, y in LOWER], fill=WHITE)
    return im.resize((size, size), Image.LANCZOS)


def save(im, path, rgb=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    (im.convert("RGB") if rgb else im).save(path, optimize=True)


def main():
    master = mark(1024)
    save(master, GO / "store" / "icon-1024.png", rgb=True)
    save(mark(512), GO / "store" / "play-icon-512.png", rgb=True)
    save(mark(512), GO / "assets" / "brand" / "go_mark.png", rgb=True)

    res = GO / "android" / "app" / "src" / "main" / "res"
    for d, px in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
        save(mark(px), res / f"mipmap-{d}" / "ic_launcher.png", rgb=True)
        # Adaptive: 108dp canvas, the visible part the middle 72dp. The V and its
        # orbit are drawn small enough to stay whole in a circle.
        n = px * 108 // 48
        save(mark(n, group=0.46, background=False), res / f"mipmap-{d}" / "ic_launcher_foreground.png")
    (res / "mipmap-anydpi-v26").mkdir(parents=True, exist_ok=True)
    (res / "mipmap-anydpi-v26" / "ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!-- Vesopa Go: the V breaking out of its orbit, on ink (tool/make_icons.py). -->\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background"/>\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
        '    <monochrome android:drawable="@mipmap/ic_launcher_foreground"/>\n'
        '</adaptive-icon>\n')
    (res / "values").mkdir(parents=True, exist_ok=True)
    (res / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        '    <color name="ic_launcher_background">#10130A</color>\n</resources>\n')

    ios = GO / "ios" / "Runner" / "Assets.xcassets" / "AppIcon.appiconset"
    contents = json.loads((ios / "Contents.json").read_text())
    for img in contents["images"]:
        if img.get("filename"):
            pt = float(img["size"].split("x")[0])
            save(mark(round(pt * int(img["scale"].rstrip("x")))), ios / img["filename"], rgb=True)
    print("icons written")


if __name__ == "__main__":
    main()
