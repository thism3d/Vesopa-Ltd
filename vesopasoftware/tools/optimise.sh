#!/usr/bin/env bash
# Build site/assets/ (what ships) from masters/ (what the model produced).
#
# tools/gen.mjs writes 2K PNGs: 4-8 MB each, ~120 MB in total, against a 6 MB
# whole-page budget. Masters stay on disk because regenerating one costs an API
# call; this produces the derivatives the page actually requests.
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob

W_WIDE=1600     # plates display at most 46rem (~736 CSS px), so 1600 covers 2x
W_TILE=1024     # seamless tiles, repeated
Q=82
before=0; after=0

note() { printf '%-40s %5sK -> %4sK\n' "$1" $(($2/1024)) $(($3/1024)); }

# 1. Photographic plates -> WebP
for d in still story video; do
  mkdir -p "site/assets/$d"
  for f in masters/$d/*.png; do
    out="site/assets/$d/$(basename "${f%.png}").webp"
    cwebp -quiet -q $Q -resize $W_WIDE 0 "$f" -o "$out"
    b=$(stat -f%z "$f"); a=$(stat -f%z "$out")
    before=$((before+b)); after=$((after+a)); note "$d/$(basename "$f")" $b $a
  done
done

# 2. Seamless tiles -> WebP at tile resolution
mkdir -p site/assets/tile
for f in masters/tile/*.png; do
  out="site/assets/tile/$(basename "${f%.png}").webp"
  cwebp -quiet -q $Q -resize $W_TILE 0 "$f" -o "$out"
  b=$(stat -f%z "$f"); a=$(stat -f%z "$out")
  before=$((before+b)); after=$((after+a)); note "tile/$(basename "$f")" $b $a
done

# 3. Particle mattes and depth maps stay PNG.
#    particles.js rasterises each one into a 256x256 canvas, so 512 is already
#    2x headroom - but they must not become WebP: chroma subsampling puts grey
#    fringes into a mask that has to be pure black and white.
mkdir -p site/assets/particles
for f in masters/particles/*_mask.png masters/particles/*_depth.png; do
  out="site/assets/particles/$(basename "$f")"
  b=$(stat -f%z "$f")
  magick "$f" -resize 512x512 -strip "$out"
  a=$(stat -f%z "$out")
  before=$((before+b)); after=$((after+a)); note "particles/$(basename "$f")" $b $a
done

# 4. Open Graph card stays PNG at exactly 1200x630 - several social scrapers
#    still will not fetch WebP, and a card that fails to render is worse than
#    a slightly larger one.
if [ -e masters/og-src.png ]; then
  magick masters/og-src.png -resize 1200x630^ -gravity center -extent 1200x630 \
    -strip -quality 88 site/assets/og.png
  echo "og.png -> 1200x630 $(( $(stat -f%z site/assets/og.png) /1024 ))K"
fi
rm -f site/assets/og.webp

echo
echo "masters $((before/1024/1024)) MB  ->  shipped $((after/1024))K"
du -sh site
