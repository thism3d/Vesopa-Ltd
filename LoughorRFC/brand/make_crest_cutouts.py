"""The club's crest without its square background, and as a round icon.

    python LoughorRFC/brand/make_crest_cutouts.py

Reads crest-original.jpeg (the club's own file, as supplied, 2026-11-19) and
writes:

  crest.png          the crest on nothing: the blue square behind the emblem
                     taken away, nothing inside the emblem touched (owner,
                     2026-11-19: "Blend the icon ... and generate transparent
                     png as well"). Every icon, banner and store picture is
                     drawn from this one.
  crest-square.png   the original square, lossless, for places that want it
  crest-circle.png   the whole crest in a disc of its own blue (round icons)

Only the background is removed: pixels that are the crest's blue field AND
joined to its outer edge. The shield's own blue quarter is inside its gold
border, so it stays. The edge is softened by a pixel and the blue glow
along it is taken out of the edge colour, so the crest sits on any colour
without a blue rim. Needs Pillow, NumPy and SciPy.
"""
import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

HERE = pathlib.Path(__file__).resolve().parent


def background(rgb):
    """The blue field joined to the edge of the picture."""
    r, g, b = (rgb[..., i].astype(int) for i in range(3))
    blue = (b > r + 45) & (b > g + 25) & (r < 90)
    # Very dark navy in the corners' vignette counts as field too.
    blue |= (r < 30) & (g < 45) & (b < 120) & (b > g)
    labels, _ = ndimage.label(blue)
    edge = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
    field = np.isin(labels, list(edge))
    # Close pin-holes (JPEG noise) in the field without eating into the emblem.
    return ndimage.binary_closing(field, iterations=2) & ~ndimage.binary_erosion(~field, iterations=1) | field


def main():
    src = Image.open(HERE / "crest-original.jpeg").convert("RGB")
    rgb = np.asarray(src)
    field = background(rgb)
    keep = ~field
    # Drop specks left in the field: only the big connected parts are the crest.
    labels, n = ndimage.label(keep)
    sizes = ndimage.sum(keep, labels, range(1, n + 1))
    keep = np.isin(labels, [i + 1 for i, s in enumerate(sizes) if s > 400])
    keep = ndimage.binary_fill_holes(keep)
    alpha = Image.fromarray((keep * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    a = np.asarray(alpha).astype(float) / 255
    # The stalks fade into the blue at their feet. Those pixels are a mix of
    # the stalks' green and the field's blue: they become green that fades
    # out (the mix's share of green is its alpha), joined to the field.
    r, g, b = (rgb[..., i].astype(float) for i in range(3))
    bluish = keep & (b > r + 30) & (g > r)
    labels, _ = ndimage.label(bluish | field)
    touching = set(np.unique(labels[field])) - {0}
    fade = bluish & np.isin(labels, list(touching))
    fade = ndimage.binary_dilation(fade, iterations=1) & keep
    field_c = np.array([2, 28, 125], float)
    green_c = np.array([24, 150, 40], float)
    d = green_c - field_c
    share = np.clip(((rgb.astype(float) - field_c) @ d) / (d @ d), 0, 1)
    a = np.where(fade, np.minimum(a, share), a)
    rgb = np.where(fade[..., None], np.broadcast_to(green_c, rgb.shape), rgb).astype(np.uint8)
    # Decontaminate the soft edge: where it is partly see-through, the blue
    # of the field is taken back out of the colour.
    field_rgb = np.array([2, 28, 125], float)
    out = rgb.astype(float)
    edge = (a > 0.02) & (a < 0.98) & ~fade
    out[edge] = np.clip((out[edge] - field_rgb * (1 - a[edge, None])) / a[edge, None], 0, 255)
    cut = Image.fromarray(np.dstack([out.astype(np.uint8), (a * 255).astype(np.uint8)]), "RGBA")
    cut = cut.crop(cut.split()[3].getbbox())
    side = max(cut.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(cut, ((side - cut.width) // 2, (side - cut.height) // 2))
    square.save(HERE / "crest.png", optimize=True)

    src.save(HERE / "crest-square.png", optimize=True)
    # Round: the whole crest inside a disc of the crest's own blue, lighter in
    # the middle as the original is, so nothing is cut off at the edge.
    side = 1024
    big = side * 4
    disc = Image.new("L", (big, big), 0)
    ImageDraw.Draw(disc).ellipse((0, 0, big - 1, big - 1), fill=255)
    disc = disc.resize((side, side), Image.LANCZOS)
    yy, xx = np.mgrid[0:side, 0:side]
    t = np.clip(np.hypot(xx - side / 2, yy - side * 0.45) / (side * 0.62), 0, 1)[..., None]
    centre, rim = np.array([16, 60, 200], float), np.array([2, 26, 116], float)
    ground = Image.fromarray((centre * (1 - t) + rim * t).astype(np.uint8), "RGB").convert("RGBA")
    ground.putalpha(disc)
    a = np.asarray(square.split()[3])
    ys, xs = np.nonzero(a > 40)
    reach = np.hypot(xs + 0.5 - square.width / 2, ys + 0.5 - square.height / 2).max() / square.height
    h = round(side * 0.47 / reach)
    crest = square.resize((h, h), Image.LANCZOS)
    ground.alpha_composite(crest, ((side - h) // 2, (side - h) // 2))
    ground.save(HERE / "crest-circle.png", optimize=True)
    print("wrote crest.png (transparent), crest-square.png, crest-circle.png")


if __name__ == "__main__":
    main()
