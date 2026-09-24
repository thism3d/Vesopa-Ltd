"""
The Microsoft Store's pictures of the loyalty app's demonstration build.

    python tool/make_store_art.py <out-dir>

The Store listing (9N6VWPJ25VPH) is the white-label demonstration: it installs
as The Vesopa Kitchen, the venue EPOS buyers are shown, so its tiles are that
venue's own logo -- the Vesopa V in white on lime with a black wedge, exactly
as the Kitchen's back office has it -- laid out the way Vesopa Express's tiles
are (vesopa_express/tool/make_store_art.py): a full tile for the icon and box
art, and a poster that is the tile with the name under it.

The V is not redrawn by eye: the polygons are favicon.svg's own coordinates.

WHAT IT WRITES (the sizes Partner Center asks for, and the other apps use)

    store_icon_300.png          1:1 app tile icon            -> Icon
    store_box_art_2160.png      1:1 box art                  -> StoreLogoSquare
    store_poster_1440x2160.png  2:3 poster art               -> StoreLogo9x16
    ../assets/brand/kitchen_demo_mark_512.png   the package's own logo

The 16:9 hero is a photograph with the real app on a tablet (see the Store kit).
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent.parent
# Express ships the family's wordmark face; borrowed rather than copied twice.
FONT = HERE.parent / "vesopa_express" / "assets" / "fonts" / "Montserrat-ExtraBold.ttf"

LIME = (165, 199, 21)
WHITE = (255, 255, 255)
INK = (17, 17, 17)

# favicon.svg, viewBox 0 0 46.35 33.09.
LEFT_ARM = [(9.95, 0), (0, 0), (18.01, 33.09), (27.96, 33.09)]
RIGHT_TOP = [(27.40, 16.54), (37.35, 16.54), (46.35, 0), (36.40, 0)]
WEDGE = [(27.40, 16.54), (18.39, 33.09), (28.34, 33.09), (37.35, 16.54)]
SHAPES = [(LEFT_ARM, WHITE), (RIGHT_TOP, WHITE), (WEDGE, INK)]


def render(size, *, fill=0.62, full_bleed=True):
    """The mark on its tile, supersampled 4x for clean edges."""
    s = size * 4
    img = Image.new("RGBA", (s, s), LIME + (255,) if full_bleed else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    xs = [x for p, _ in SHAPES for x, _ in p]
    ys = [y for p, _ in SHAPES for _, y in p]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    scale = (s * fill) / w
    ox = (s - w * scale) / 2 - min(xs) * scale
    oy = (s - h * scale) / 2 - min(ys) * scale
    for poly, colour in SHAPES:
        d.polygon([(ox + x * scale, oy + y * scale) for x, y in poly], fill=colour + (255,))
    return img.resize((size, size), Image.LANCZOS)


def fit(d, word, width, start):
    size = start
    font = ImageFont.truetype(str(FONT), size)
    while d.textlength(word, font=font) > width:
        size -= 4
        font = ImageFont.truetype(str(FONT), size)
    return font


def poster(width=1440, height=2160):
    """The tile on a tall ground, with the venue's name under the mark."""
    img = Image.new("RGB", (width, height), LIME)
    mark = render(1600, full_bleed=False)
    mark = mark.crop(mark.getbbox())
    target_w = int(width * 0.80)
    mark = mark.resize((target_w, int(mark.height * target_w / mark.width)), Image.LANCZOS)
    top = int(height * 0.22)
    img.paste(mark, ((width - mark.width) // 2, top), mark)

    d = ImageDraw.Draw(img)
    # KITCHEN as wide as EXPRESS sits on Express's poster; THE VESOPA above it,
    # smaller, so the name reads whole without shrinking the word that matters.
    big = fit(d, "KITCHEN", width * 0.70, 300)
    small = fit(d, "THE VESOPA", width * 0.46, 140)
    y = top + mark.height + int(height * 0.07)
    w = d.textlength("THE VESOPA", font=small)
    d.text(((width - w) / 2, y), "THE VESOPA", font=small, fill=INK)
    y += int(small.size * 1.25)
    w = d.textlength("KITCHEN", font=big)
    d.text(((width - w) / 2, y), "KITCHEN", font=big, fill=WHITE)
    return img


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "build" / "store-art"
    out.mkdir(parents=True, exist_ok=True)
    # Fuller than an app icon, as Express's Store tiles are.
    render(300, fill=0.78).convert("RGB").save(out / "store_icon_300.png")
    render(2160, fill=0.78).convert("RGB").save(out / "store_box_art_2160.png")
    poster().save(out / "store_poster_1440x2160.png")
    render(512).save(HERE / "assets" / "brand" / "kitchen_demo_mark_512.png")
    for p in sorted(out.glob("store_*.png")):
        with Image.open(p) as im:
            print(f"{p.name:32} {im.size[0]}x{im.size[1]}")


if __name__ == "__main__":
    main()
