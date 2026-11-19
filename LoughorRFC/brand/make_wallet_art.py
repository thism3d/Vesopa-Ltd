"""The club's Wallet card artwork, from its own crest.

    python LoughorRFC/brand/make_wallet_art.py

Apple Wallet (vesopa_server/assets/wallet/looks/loughor-rfc/, read by
wallet_apple.js artworkFor through venue_looks.js): icon, logo and the strip
behind the card's points, the same sizes as Pontardawe's.

Google Wallet (vesopa_server/public/assets/venues/loughor-rfc/, public HTTPS
for Google to fetch): wallet-logo.png (660x660, Google masks it to a circle:
the round crest), wallet-hero.png (1032x336), wallet-wordmark.png (1280x400,
the card's wide logo: the crest and the club's name, transparent) and
wallet-banner.png (1860x620, the pass's image module: the crest, the name and
"Villa Field · Est. 1882"). Lettering in the website's Fraunces (OFL).
"""
import pathlib

from PIL import Image, ImageDraw, ImageEnhance, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
APPLE = ROOT / "vesopa_server" / "assets" / "wallet" / "looks" / "loughor-rfc"
GOOGLE = ROOT / "vesopa_server" / "public" / "assets" / "venues" / "loughor-rfc"
DEEP, BLUE = (7, 26, 82), (18, 56, 168)
GOLD = (245, 197, 24)
FONTS = ROOT / "LoughorRFC" / "website" / "src" / "fonts"


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def band(w, h):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for x in range(w):
        t = x / (w - 1)
        c = tuple(int(DEEP[i] * (1 - t) + BLUE[i] * t) for i in range(3))
        for y in range(h):
            px[x, y] = c
    return img.convert("RGBA")


def fit(crest, size):
    c = crest.copy()
    c.thumbnail((size, size), Image.LANCZOS)
    return c


def main():
    crest = Image.open(HERE / "crest.png").convert("RGBA")
    APPLE.mkdir(parents=True, exist_ok=True)
    GOOGLE.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon.png", 29), ("icon@2x.png", 58), ("logo.png", 50), ("logo@2x.png", 100)):
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        c = fit(crest, size)
        canvas.alpha_composite(c, ((size - c.width) // 2, (size - c.height) // 2))
        canvas.save(APPLE / name, optimize=True)
    for name, (w, h) in (("strip.png", (375, 98)), ("strip@2x.png", (750, 196))):
        img = band(w, h)
        c = fit(crest, int(h * 1.5))
        a = c.split()[3].point(lambda v: int(v * 0.35))
        c.putalpha(a)
        img.alpha_composite(c, (w - int(c.width * 0.8), (h - c.height) // 2))
        img.convert("RGB").save(APPLE / name, optimize=True)
    Image.open(HERE / "crest-circle.png").convert("RGBA").resize((660, 660), Image.LANCZOS).save(GOOGLE / "wallet-logo.png", optimize=True)
    hero = band(1032, 336)
    c = fit(crest, 300)
    hero.alpha_composite(c, ((1032 - c.width) // 2, (336 - c.height) // 2))
    hero.convert("RGB").save(GOOGLE / "wallet-hero.png", optimize=True)

    # The wide logo: crest, then the name, on nothing (the card's own blue).
    wm = Image.new("RGBA", (1280, 400), (0, 0, 0, 0))
    c = fit(crest, 340)
    wm.alpha_composite(c, (20, (400 - c.height) // 2))
    d = ImageDraw.Draw(wm)
    d.text((40 + c.width + 30, 200), "Loughor RFC", font=font("Fraunces-SemiBold.ttf", 150), fill=(255, 255, 255), anchor="lm")
    wm.save(GOOGLE / "wallet-wordmark.png", optimize=True)

    # The image module: a programme-cover banner.
    ban = band(1860, 620)
    c = fit(crest, 520)
    ban.alpha_composite(c, (90, (620 - c.height) // 2))
    d = ImageDraw.Draw(ban)
    x = 90 + c.width + 70
    d.text((x, 250), "Loughor RFC", font=font("Fraunces-SemiBold.ttf", 170), fill=(255, 255, 255), anchor="ls")
    d.rectangle((x + 4, 290, x + 220, 298), fill=GOLD)
    d.text((x + 4, 400), "Villa Field \u00b7 Est. 1882", font=font("SourceSans3-SemiBold.ttf", 78), fill=GOLD, anchor="ls")
    d.text((x + 4, 490), "Members' card", font=font("Fraunces-Italic.ttf", 70), fill=(225, 232, 255), anchor="ls")
    ban.convert("RGB").save(GOOGLE / "wallet-banner.png", optimize=True)
    print("wrote", APPLE.relative_to(ROOT), "and", GOOGLE.relative_to(ROOT))


if __name__ == "__main__":
    main()
