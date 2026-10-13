"""Draw the Vesopa V app icons from the brand's vector mark (2026-10-13).

    python tool/make_vesopa_icons.py

The EPOS, Customer Display and Kitchen icons had the V's right arm cut off
flat at the top (the mark was drawn wider than its box), and the Microsoft
Store package then trimmed the tile's border away (msix trim_logo, on by
default), so the taskbar showed a zoomed, chopped V. This draws the whole mark
from favicon.svg's three polygons, centred with even padding, at 1024px
(4x supersampled), and writes each app's master PNG (its msix logo_path and
launcher icon) and its Windows .ico.
"""
import pathlib

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[1]

# favicon.svg, viewBox 0 0 46.35 33.09.
VIEW_W, VIEW_H = 46.35, 33.09
LEFT = [(9.95, 0), (0, 0), (18.01, 33.09), (27.96, 33.09)]
UPPER_RIGHT = [(27.4, 16.54), (37.35, 16.54), (46.35, 0), (36.4, 0)]
LOWER_RIGHT = [(27.4, 16.54), (18.39, 33.09), (28.34, 33.09), (37.35, 16.54)]

GREEN = (165, 199, 21, 255)
WHITE = (255, 255, 255, 255)
BLACK = (17, 17, 17, 255)

# app: (master png, ico, background, left arm, upper right, lower right)
APPS = {
    "vesopa_epos": ("assets/brand/512x512.png", GREEN, WHITE, WHITE, BLACK),
    "vesopa_epos_display": ("assets/brand/512x512.png", GREEN, WHITE, WHITE, BLACK),
    "vesopa_epos_kitchen": ("assets/brand/kitchen_mark.png", BLACK, GREEN, GREEN, WHITE),
}

SIZE = 1024
MARK_WIDTH = 0.58  # of the tile: the whole V, with room round it at every size
SS = 4


def draw(bg, left, upper, lower, size=SIZE):
    big = size * SS
    im = Image.new("RGBA", (big, big), bg)
    d = ImageDraw.Draw(im)
    scale = big * MARK_WIDTH / VIEW_W
    ox = (big - VIEW_W * scale) / 2
    oy = (big - VIEW_H * scale) / 2
    for poly, colour in ((LEFT, left), (UPPER_RIGHT, upper), (LOWER_RIGHT, lower)):
        d.polygon([(ox + x * scale, oy + y * scale) for x, y in poly], fill=colour)
    return im.resize((size, size), Image.LANCZOS)


def main():
    for app, (png, bg, left, upper, lower) in APPS.items():
        master = draw(bg, left, upper, lower)
        out = ROOT / app / png
        master.save(out, optimize=True)
        ico = ROOT / app / "windows" / "runner" / "resources" / "app_icon.ico"
        sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
        # Each size drawn from the vector, not shrunk from 1024, so small
        # sizes stay sharp.
        frames = [draw(bg, left, upper, lower, s) for s in sizes]
        frames[-1].save(ico, format="ICO", sizes=[(s, s) for s in sizes],
                        append_images=frames[:-1])
        print(f"{app}: {out.relative_to(ROOT)} and {ico.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
