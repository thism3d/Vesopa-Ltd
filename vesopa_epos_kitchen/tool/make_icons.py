"""
Vesopa Kitchen's mark, derived from the Vesopa one.

The geometry is not redrawn — it is the brand mark's own pixels, recoloured.
Redrawing a logo by hand is how a wordmark ends up subtly wrong, and the V's
angles are the whole identity.

The palette is inverted instead:

    lime  -> chrome  the square goes near-black
    white -> lime    the V becomes the brand colour
    black -> white   the wedge inverts with it

That keeps it unmistakably Vesopa while making it instantly separable from the
till on a taskbar, which is the one job an application icon has in a venue
running both.
"""

import sys
from pathlib import Path

from PIL import Image

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])

# Kds.chromeHeader, Kds.brand, and white — the same three the app is drawn in.
CHROME = (17, 17, 17)
LIME = (165, 199, 21)
WHITE = (255, 255, 255)


def classify(px):
    """Which of the mark's three inks a pixel is closest to."""
    r, g, b, *_ = px
    # The source is flat colour with antialiased edges, so nearest-of-three on
    # squared distance is exact in the interiors and sensible on the edges.
    candidates = {
        LIME: (165, 199, 21),
        WHITE: (255, 255, 255),
        (0, 0, 0): (0, 0, 0),
    }
    best, best_d = None, None
    for key, ref in candidates.items():
        d = (r - ref[0]) ** 2 + (g - ref[1]) ** 2 + (b - ref[2]) ** 2
        if best_d is None or d < best_d:
            best, best_d = key, d
    return best


MAP = {
    LIME: CHROME,      # the square
    WHITE: LIME,       # the V
    (0, 0, 0): WHITE,  # the wedge
}

src = Image.open(SRC).convert("RGBA")
w, h = src.size
out = Image.new("RGBA", (w, h))

src_px = src.load()
out_px = out.load()

for y in range(h):
    for x in range(w):
        r, g, b, a = src_px[x, y]
        if a == 0:
            # Transparent stays transparent, but the mark's square is opaque so
            # this only ever fires outside it.
            out_px[x, y] = (0, 0, 0, 0)
            continue
        nr, ng, nb = MAP[classify((r, g, b))]
        out_px[x, y] = (nr, ng, nb, a)

OUT.parent.mkdir(parents=True, exist_ok=True)
out.save(OUT)
print(f"wrote {OUT} ({out.size[0]}x{out.size[1]})")

# A multi-size .ico for the Windows runner and the taskbar. 16 and 24 matter
# most and are where a busy mark falls apart — which is the reason this one is
# a recolour of a shape that already works at that size rather than a new
# drawing with a saucepan in it.
ico = OUT.with_suffix(".ico")
out.save(
    ico,
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print(f"wrote {ico}")

# A 44x44 and a 150x150 for the Store tile, plus a 256 for the MSIX logo.
for size in (44, 150, 256):
    scaled = out.resize((size, size), Image.LANCZOS)
    path = OUT.with_name(f"{OUT.stem}_{size}.png")
    scaled.save(path)
    print(f"wrote {path}")
