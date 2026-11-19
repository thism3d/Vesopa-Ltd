"""Google Play's Android TV banner for Vesopa Go (1280x720), in the look of the
feature graphic (make_feature_graphic.py) and the launcher's banner
(android/app/src/main/res/drawable-xhdpi/tv_banner.png): the mark, the name,
and what Go does on a television.

    python vesopa_go/tool/make_tv_banner.py

Writes store/play-tv-banner-1280x720.png (24-bit PNG, no transparency, as
Play asks). Needs Pillow and the Inter font (falls back to DejaVu Sans).
"""
from PIL import Image, ImageDraw, ImageFilter

from make_feature_graphic import FONTS, STORE, TEXT, font
from make_icons import INK, LIME, WHITE, mark

W, H = 1280, 720


def main():
    bg = Image.new("RGB", (W, H), INK)
    glow = Image.new("L", (W, H), 0)
    g = ImageDraw.Draw(glow)
    g.ellipse((760, -160, 1500, 620), fill=120)
    g.ellipse((60, 160, 420, 520), fill=50)
    glow = glow.filter(ImageFilter.GaussianBlur(150))
    bg.paste(Image.new("RGB", (W, H), LIME), (0, 0), glow.point(lambda v: v * 0.5))
    canvas = bg.convert("RGBA")

    tile = mark(250, background=True, glow=True).convert("RGBA")
    m = Image.new("L", tile.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, tile.width - 1, tile.height - 1), radius=56, fill=255)
    tile.putalpha(m)
    canvas.alpha_composite(tile, (110, (H - tile.height) // 2 - 40))

    d = ImageDraw.Draw(canvas)
    x = 430
    big = font(FONTS, 132)
    d.text((x, 196), "Vesopa", font=big, fill=WHITE)
    d.text((x + d.textlength("Vesopa ", font=big), 196), "Go", font=big, fill=LIME)
    small = font(TEXT, 40)
    d.text((x + 4, 376), "Kitchen board and customer display", font=small, fill=(225, 230, 210))
    d.text((x + 4, 428), "on your TV", font=small, fill=(225, 230, 210))
    # The lime dot of the launcher's banner, bottom right.
    d.ellipse((W - 92, H - 92, W - 56, H - 56), fill=LIME)
    out = STORE / "play-tv-banner-1280x720.png"
    canvas.convert("RGB").save(out, optimize=True)
    print(out.relative_to(STORE.parent))


if __name__ == "__main__":
    main()
