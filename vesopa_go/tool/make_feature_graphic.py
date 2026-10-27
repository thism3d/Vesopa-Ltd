"""Google Play's feature graphic for Vesopa Go (1024x500), from the brand mark
and two of the store screenshots.

    python vesopa_go/tool/make_feature_graphic.py

Writes store/play-feature-graphic-1024x500.png. Needs Pillow and the Inter font
(falls back to DejaVu Sans). Run make_icons.py first (for the mark), and take
the screenshots first (store/screenshots/android-phone).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from make_icons import INK, LIME, WHITE, mark

GO = Path(__file__).resolve().parents[1]
STORE = GO / "store"
W, H = 1024, 500
FONTS = ["/usr/share/fonts/opentype/inter/InterDisplay-Black.otf", "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]
TEXT = ["/usr/share/fonts/opentype/inter/Inter-Medium.otf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]


def font(paths, size):
    for p in paths:
        if Path(p).is_file():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default(size)


def phone(shot, height):
    """A screenshot in a rounded dark phone frame, with a soft shadow."""
    im = Image.open(shot).convert("RGB")
    w = round(height * im.width / im.height)
    im = im.resize((w, height), Image.LANCZOS)
    bez = 9
    frame = Image.new("RGBA", (w + 2 * bez, height + 2 * bez), (0, 0, 0, 0))
    d = ImageDraw.Draw(frame)
    d.rounded_rectangle((0, 0, frame.width - 1, frame.height - 1), radius=34, fill=(36, 40, 30, 255), outline=(70, 78, 55, 255), width=2)
    m = Image.new("L", im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, height - 1), radius=26, fill=255)
    frame.paste(im, (bez, bez), m)
    return frame


def main():
    bg = Image.new("RGB", (W, H), INK)
    # A lime glow behind the phones, and a faint one behind the mark.
    glow = Image.new("L", (W, H), 0)
    g = ImageDraw.Draw(glow)
    g.ellipse((600, -40, 1120, 560), fill=120)
    g.ellipse((20, 120, 300, 380), fill=40)
    glow = glow.filter(ImageFilter.GaussianBlur(110))
    bg.paste(Image.new("RGB", (W, H), LIME), (0, 0), glow.point(lambda v: v * 0.55))
    canvas = bg.convert("RGBA")

    shots = sorted((STORE / "screenshots" / "android-phone").glob("*.png"))
    back, front = phone(shots[2], 380), phone(shots[0], 430)
    for frame, xy, angle in ((back, (800, 60), 8), (front, (640, 40), -4)):
        f = frame.rotate(angle, expand=True, resample=Image.BICUBIC)
        shadow = Image.new("RGBA", f.size, (0, 0, 0, 0))
        shadow.putalpha(f.getchannel("A").point(lambda v: v * 0.6).filter(ImageFilter.GaussianBlur(18)))
        canvas.alpha_composite(shadow, (xy[0] + 10, xy[1] + 18))
        canvas.alpha_composite(f, xy)

    tile = mark(132, background=True, glow=True).convert("RGBA")
    m = Image.new("L", tile.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, tile.width - 1, tile.height - 1), radius=30, fill=255)
    tile.putalpha(m)
    canvas.alpha_composite(tile, (64, 92))

    d = ImageDraw.Draw(canvas)
    big = font(FONTS, 76)
    d.text((64, 252), "Vesopa", font=big, fill=WHITE)
    d.text((64 + d.textlength("Vesopa ", font=big), 252), "Go", font=big, fill=LIME)
    small = font(TEXT, 25)
    d.text((66, 352), "Orders and payments,", font=small, fill=(225, 230, 210))
    d.text((66, 386), "anywhere in your venue.", font=small, fill=(225, 230, 210))
    canvas.convert("RGB").save(STORE / "play-feature-graphic-1024x500.png", optimize=True)
    print("store/play-feature-graphic-1024x500.png")


if __name__ == "__main__":
    main()
