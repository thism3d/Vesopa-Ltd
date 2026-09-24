"""Round the corners of Vesopa's square icon tiles (2026-09-17).

    python tool/round_brand_icons.py          # rewrite them in place
    python tool/round_brand_icons.py --check  # list which are still square

The owner's direction: the Vesopa branding stays as it is, but a square icon
or logo tile is wrong -- the mark sits on a tile with rounded corners, the way
the app icons and auth.vesopa.com's app logo already look. So every favicon and
"any"-purpose web icon is given transparent corners at 22.5% of its size.

LEFT SQUARE ON PURPOSE
  * apple-touch-icon.png  iOS rounds these itself, and a transparent corner
                          there is drawn black
  * *maskable*            Android crops these to its own shape; they must be
                          full bleed
  * wordmarks             not tiles

auth.vesopa.com's favicons were a CIRCLE; they become the same black rounded
tile as its app logo, drawn from icon-512.png.
"""
import pathlib
import sys

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[1]
RADIUS = 0.225

# PNG tiles rounded in place (largest source kept at its own size).
PNGS = [
    "vesopa_auth/public/brand/icon-192.png",
    "vesopa_auth/public/brand/icon-512.png",
    "vesopa_hosting/public/favicon.png",
    "vesopa_loyalty/web/favicon.png",
    "vesopa_loyalty/web/icons/Icon-192.png",
    "vesopa_loyalty/web/icons/Icon-512.png",
    "vesopa_loyalty/assets/vesopa-mark.png",
    "vesopa_server/public/assets/favicon.png",
    "vesopa_server/public/assets/logo.png",
    "vesopa_web/public/favicon.png",
    "vesopa_web/public/assets/logo/logo.png",
    "vesopasoftware/site/assets/icon-32.png",
    "vesopasoftware/site/assets/icon-192.png",
    "vesopasoftware/site/assets/icon-512.png",
]

# ICO files: rebuilt from a rounded source at these sizes.
ICOS = {
    "vesopa_hosting/public/favicon.ico": ("vesopa_hosting/public/favicon.png", [16, 32, 48, 64]),
    "vesopa_server/public/assets/favicon.ico": ("vesopa_server/public/assets/favicon.png", [16, 32, 48, 256]),
    "vesopa_web/public/favicon.ico": ("vesopa_web/public/favicon.png", [16, 32, 48, 256]),
    "vesopasoftware/site/favicon.ico": ("vesopasoftware/site/assets/icon-512.png", [16, 32, 48]),
    "vesopasoftware/site/assets/favicon.ico": ("vesopasoftware/site/assets/icon-512.png", [16, 32, 48]),
    "vesopa_auth/public/favicon.ico": ("vesopa_auth/public/brand/icon-512.png", [16, 32, 48]),
    "vesopa_auth/public/brand/favicon.ico": ("vesopa_auth/public/brand/icon-512.png", [16, 32, 48]),
}

# Small PNG favicons re-drawn from a large rounded source (a circle today).
FROM_SOURCE = {
    "vesopa_auth/public/brand/favicon-16.png": ("vesopa_auth/public/brand/icon-512.png", 16),
    "vesopa_auth/public/brand/favicon-32.png": ("vesopa_auth/public/brand/icon-512.png", 32),
    "vesopa_auth/public/brand/favicon-48.png": ("vesopa_auth/public/brand/icon-512.png", 48),
}


def rounded(image):
    """The image with transparent corners, anti-aliased by drawing the mask 4x."""
    im = image.convert("RGBA")
    w, h = im.size
    scale = 4
    mask = Image.new("L", (w * scale, h * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, w * scale - 1, h * scale - 1), radius=int(min(w, h) * scale * RADIUS), fill=255
    )
    mask = mask.resize((w, h), Image.LANCZOS)
    alpha = Image.composite(im.getchannel("A"), Image.new("L", (w, h), 0), mask)
    im.putalpha(alpha)
    return im


def is_square(path):
    im = Image.open(path).convert("RGBA")
    return im.getpixel((0, 0))[3] > 0


def main():
    check = "--check" in sys.argv
    for rel in PNGS:
        p = ROOT / rel
        if check:
            print(f"{'SQUARE ' if is_square(p) else 'rounded'}  {rel}")
            continue
        if is_square(p):
            rounded(Image.open(p)).save(p, optimize=True)
            print(f"rounded  {rel}")
    if check:
        return
    for rel, (src, size) in FROM_SOURCE.items():
        big = rounded(Image.open(ROOT / src))
        big.resize((size, size), Image.LANCZOS).save(ROOT / rel, optimize=True)
        print(f"redrawn  {rel} ({size}px)")
    for rel, (src, sizes) in ICOS.items():
        big = rounded(Image.open(ROOT / src))
        largest = max(sizes)
        base = big.resize((largest, largest), Image.LANCZOS)
        base.save(ROOT / rel, format="ICO", sizes=[(s, s) for s in sizes])
        print(f"ico      {rel} {sizes}")
    svg = ROOT / "vesopa_auth/public/brand/favicon.svg"
    text = svg.read_text(encoding="utf-8")
    if '<circle cx="32" cy="32" r="32"' in text:
        svg.write_text(text.replace('<circle cx="32" cy="32" r="32" fill="#000000"/>',
                                    '<rect width="64" height="64" rx="14.4" fill="#000000"/>'), encoding="utf-8")
        print("svg      vesopa_auth/public/brand/favicon.svg (circle -> rounded tile)")


if __name__ == "__main__":
    main()
