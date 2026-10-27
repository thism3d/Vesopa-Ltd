"""Vesopa Go's icon, drawn from the Vesopa V (logo.svg's three shapes), and
every size the stores and launchers ask for.

    python vesopa_go/tool/make_icons.py

The tile is ink (#10130A), so Go is told apart from the lime Vesopa EPOS icon
beside it; the V keeps its lime strokes, its dark stroke turns white to read on
ink, and three speed lines trail it: Go. Drawn 4x and scaled down for clean
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


LINES = [(0.22, 0.46, 255), (0.48, 0.34, 190), (0.74, 0.22, 120)]  # height share, length (V widths), alpha
GAP = 0.07  # between a line's end and the V, in V widths


def mark(size, group=0.70, background=True, glow=True):
    """The icon at `size` px: the V and its speed lines, as one group `group`
    of the tile wide, centred."""
    s = size * 4
    im = Image.new("RGBA", (s, s), INK + (255,) if background else (0, 0, 0, 0))
    lead = GAP + max(length for _, length, _ in LINES)
    vw = s * group / (1 + lead)  # the V's own width
    k = vw / W
    gx = (s - s * group) / 2  # the group's left edge
    ox = gx + lead * vw
    oy = (s - H * k) / 2
    if background and glow:
        halo = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        r = s * 0.40
        cx = ox + vw / 2
        ImageDraw.Draw(halo).ellipse((cx - r, s / 2 - r, cx + r, s / 2 + r), fill=LIME + (34,))
        im = Image.alpha_composite(im, halo.filter(ImageFilter.GaussianBlur(s * 0.09)))
    d = ImageDraw.Draw(im)

    def poly(points, colour):
        d.polygon([(ox + x * k, oy + y * k) for x, y in points], fill=colour)

    bar_h = H * k * 0.09
    for frac, length, alpha in LINES:
        y = oy + H * k * frac
        edge = ox + 18.01 * frac * k  # the left stroke's outer edge at that height
        x1 = edge - GAP * vw
        d.rounded_rectangle((x1 - length * vw, y - bar_h / 2, x1, y + bar_h / 2), radius=bar_h / 2, fill=LIME + (alpha,))
    poly(LEFT, LIME)
    poly(UPPER, LIME)
    poly(LOWER, WHITE)
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
        # lines are drawn small enough to stay whole in a circle.
        n = px * 108 // 48
        save(mark(n, group=0.46, background=False), res / f"mipmap-{d}" / "ic_launcher_foreground.png")
    (res / "mipmap-anydpi-v26").mkdir(parents=True, exist_ok=True)
    (res / "mipmap-anydpi-v26" / "ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!-- Vesopa Go: the V with its speed lines on ink (tool/make_icons.py). -->\n'
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
