"""
Microsoft Store art for Metric Membership, from Metric Group's own mark.

    python tool/make_store_art.py

  * assets/brand/metric-store-300.png: the 300x300 Store logo (Partner
    Center, Store listing > Store logos)
  * assets/brand/metric-store-512.png: the package logo msix_config uses
    (pubspec.yaml logo_path); msix makes every tile size from it

Opaque white square with the mark inside a 14% margin, the same tile the
launcher icons use (tool/make_app_icons.py), so the Store and the Start menu
show one icon.
"""

from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent.parent
MARK = Image.open(HERE / "assets" / "brand" / "metric-icon.png").convert("RGBA")


def square(size, pad=0.14):
    out = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    inner = round(size * (1 - 2 * pad))
    mark = MARK.resize((inner, inner), Image.LANCZOS)
    at = (size - inner) // 2
    out.alpha_composite(mark, (at, at))
    return out.convert("RGB")


for size in (300, 512):
    path = HERE / "assets" / "brand" / f"metric-store-{size}.png"
    square(size).save(path, optimize=True)
    print("wrote", path.relative_to(HERE))
