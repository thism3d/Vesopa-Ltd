"""
Vesopa Express's mark, drawn from the Vesopa V's own geometry.

The V is not redrawn by eye. Its three polygons are the brand mark's own
coordinates (favicon.svg at the repository root), scaled -- redrawing a logo by
hand is how a wordmark ends up subtly wrong, and the V's angles are the whole
identity.

THREE APPS, THREE COLOURWAYS OF ONE SHAPE

    Vesopa EPOS      lime square,  white V,  black wedge
    Vesopa Kitchen   black square, lime V,   white wedge
    Vesopa Express   paper square, ink V,    lime wedge  + two speed lines

Express is the one customers see, so it is the light one: a paper ground reads
as friendly and open where the till and the kitchen read as tools. The two
horizontal speed lines trailing the V are the only addition to the shape --
their ends are cut at exactly the V's own angle, so they read as part of the
mark rather than decoration stuck beside it -- and they are what makes the
Express icon separable from the other two at 24 pixels on a taskbar.

Usage:  python tool/make_icons.py            (writes assets/brand/*)
"""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "assets" / "brand"
OUT.mkdir(parents=True, exist_ok=True)

PAPER = (246, 247, 240)
INK = (16, 19, 10)
LIME = (165, 199, 21)

# favicon.svg, viewBox 0 0 46.35 33.09.
LEFT_ARM = [(9.95, 0), (0, 0), (18.01, 33.09), (27.96, 33.09)]
RIGHT_TOP = [(27.40, 16.54), (37.35, 16.54), (46.35, 0), (36.40, 0)]
WEDGE = [(27.40, 16.54), (18.39, 33.09), (28.34, 33.09), (37.35, 16.54)]

# The V's slant: x moves 18.01 for every 33.09 of y.
SLANT = 18.01 / 33.09


def speed_lines():
    """Two bars trailing left of the V, their ends cut at the V's angle.

    In the V's own units. Each bar is a parallelogram whose left and right
    edges are parallel to the left arm; the upper one is longer, so the pair
    reads as motion to the right rather than as an equals sign.
    """
    bars = []
    for top, height, left, right in ((9.3, 4.6, -15.5, -2.2), (17.8, 4.6, -11.0, 2.5)):
        bottom = top + height
        bars.append([
            (left + top * SLANT, top),
            (right + top * SLANT, top),
            (right + bottom * SLANT, bottom),
            (left + bottom * SLANT, bottom),
        ])
    return bars


def render(size, *, ground=PAPER, full_bleed=True, lines=True, fill=0.62):
    """Draw the mark at `size`, supersampled 4x then reduced for clean edges.

    `fill` is how much of the tile's width the V and its lines take. 0.62 is
    the app icon's, matched to the till's and the kitchen's; the Store's own
    tiles use more (see make_store_art.py), as the Kitchen's Store logo does.
    """
    s = size * 4
    img = Image.new("RGBA", (s, s), ground + (255,) if full_bleed else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    shapes = [(LEFT_ARM, INK), (RIGHT_TOP, INK), (WEDGE, LIME)]
    if lines:
        shapes += [(bar, LIME) for bar in speed_lines()]

    xs = [x for poly, _ in shapes for x, _ in poly]
    ys = [y for poly, _ in shapes for _, y in poly]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    # The V and its lines fill 62% of the tile's width, centred -- the same
    # optical weight as the till's and the kitchen's V.
    scale = (s * fill) / w
    ox = (s - w * scale) / 2 - min(xs) * scale
    oy = (s - h * scale) / 2 - min(ys) * scale

    for poly, colour in shapes:
        d.polygon([(ox + x * scale, oy + y * scale) for x, y in poly], fill=colour + (255,))
    return img.resize((size, size), Image.LANCZOS)


def svg():
    """The same drawing as a scalable master, in the V's own coordinates."""
    shapes = [(LEFT_ARM, INK), (RIGHT_TOP, INK), (WEDGE, LIME)] + [(b, LIME) for b in speed_lines()]
    xs = [x for p, _ in shapes for x, _ in p]
    ys = [y for p, _ in shapes for _, y in p]
    minx, miny, w, h = min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)
    side = w / 0.62
    pad_x, pad_y = (side - w) / 2 - minx, (side - h) / 2 - miny
    hexc = lambda c: "#%02X%02X%02X" % c
    body = "".join(
        '<polygon points="%s" fill="%s"/>' % (
            " ".join("%.2f,%.2f" % (x + pad_x, y + pad_y) for x, y in p), hexc(c))
        for p, c in shapes
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %.2f %.2f">'
        '<rect width="100%%" height="100%%" fill="%s"/>%s</svg>\n' % (side, side, hexc(PAPER), body)
    )


if __name__ == "__main__":
    big = render(1024)
    big.save(OUT / "express_mark.png")
    for size in (44, 150, 256, 512):
        render(size).save(OUT / f"express_mark_{size}.png")
    # Transparent, lines and all, for putting on the app's own dark and light
    # surfaces rather than on a tile.
    render(512, full_bleed=False).save(OUT / "express_mark_glyph.png")
    big.save(
        OUT / "express_mark.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    (OUT / "express_mark.svg").write_text(svg(), encoding="utf-8")
    print("wrote", sorted(p.name for p in OUT.iterdir()))
