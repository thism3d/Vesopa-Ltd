"""Social posts for Loughor RFC's app, posted by Vesopa Software.

Backgrounds: Gemini (gemini/*.jpg, made with no text, logos or crests).
On top, drawn here: the club's own crest exactly as supplied
(LoughorRFC/brand/crest.png), the app's real store screenshots, the
Vesopa logo and the words. Run: python documents/social/loughor-rfc-app/make_posts.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageEnhance

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
OSWALD = str(ROOT / "vesopa_server/public/assets/fonts/oswald/oswald-700.ttf")
MONT_B = str(ROOT / "vesopa_express/assets/fonts/Montserrat-Bold.ttf")
MONT_SB = str(ROOT / "vesopa_express/assets/fonts/Montserrat-SemiBold.ttf")
MONT = str(ROOT / "vesopa_express/assets/fonts/Montserrat-Medium.ttf")
CREST = Image.open(ROOT / "LoughorRFC/brand/crest.png").convert("RGBA")
LOGO = Image.open(ROOT / "vesopa_web/public/assets/logo/vesopa_logo_on_dark.png").convert("RGBA")
LOGO = LOGO.crop(LOGO.getbbox())
SHOTS = ROOT / "LoughorRFC/store/screenshots/android-phone"
GOLD, DEEP, BLUE, WHITE = (245, 197, 24), (7, 26, 82), (18, 56, 168), (255, 255, 255)
PLAY = "play.google.com/store/apps/details?id=com.vesopaepos.loughorrfc"


def font(path, size):
    return ImageFont.truetype(path, size)


def cover(path, w, h, bright=1.0):
    im = Image.open(path).convert("RGB")
    s = max(w / im.width, h / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    l, t = (im.width - w) // 2, (im.height - h) // 2
    im = im.crop((l, t, l + w, t + h))
    return ImageEnhance.Brightness(im).enhance(bright).convert("RGBA")


def shade(im, box, top_alpha, bottom_alpha, colour=DEEP, horizontal=False):
    """A gradient of the club's deep blue over part of the picture."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    n = w if horizontal else h
    g = Image.new("L", (n, 1))
    g.putdata([round(top_alpha + (bottom_alpha - top_alpha) * i / max(n - 1, 1)) for i in range(n)])
    g = g.resize((w, h)) if horizontal else g.rotate(-90, expand=True).resize((w, h))
    layer = Image.new("RGBA", (w, h), colour + (0,))
    layer.putalpha(g)
    im.alpha_composite(layer, (x0, y0))


def phone(shot, width):
    """The phone, as drawn in the app's own store screenshot (bezel and screen), cut out."""
    im = Image.open(SHOTS / shot).convert("RGBA").crop((177, 369, 904, 1920))
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, im.width - 1, im.height + 200), 105, fill=255)
    im.putalpha(mask)
    s = width / im.width
    return im.resize((width, round(im.height * s)), Image.LANCZOS)


def put_shadowed(im, layer, xy, blur=40, alpha=170, offset=(0, 18)):
    sh = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    sh.putalpha(layer.getchannel("A").point(lambda a: a * alpha // 255))
    pad = blur * 3
    big = Image.new("RGBA", (layer.width + pad * 2, layer.height + pad * 2), (0, 0, 0, 0))
    big.alpha_composite(sh, (pad, pad))
    big = big.filter(ImageFilter.GaussianBlur(blur))
    im.alpha_composite(big, (xy[0] - pad + offset[0], xy[1] - pad + offset[1]))
    im.alpha_composite(layer, xy)


def crest(size, glow=True):
    c = CREST.resize((size, size), Image.LANCZOS)
    if not glow:
        return c, 0
    pad = size // 4
    g = Image.new("RGBA", (size + pad * 2, size + pad * 2), (0, 0, 0, 0))
    a = c.getchannel("A").point(lambda v: v * 150 // 255)
    halo = Image.new("RGBA", c.size, GOLD + (0,))
    halo.putalpha(a)
    g.alpha_composite(halo, (pad, pad))
    g = g.filter(ImageFilter.GaussianBlur(size // 14))
    g.alpha_composite(c, (pad, pad))
    return g, pad


def text(d, xy, s, f, fill=WHITE, anchor="la", shadow=True, spacing=0):
    if shadow:
        d.text((xy[0] + 2, xy[1] + 4), s, font=f, fill=(0, 0, 0, 140), anchor=anchor, spacing=spacing)
    d.text(xy, s, font=f, fill=fill, anchor=anchor, spacing=spacing)


def lines(d, xy, rows, f, step, fills=None, anchor="la"):
    """Rows of a headline at a fixed step (Oswald's own line gap is too tall)."""
    for i, row in enumerate(rows):
        text(d, (xy[0], xy[1] + i * step), row, f, fill=(fills or {}).get(i, WHITE), anchor=anchor)


def pill(d, xy, s, f, bg=GOLD, fg=DEEP, pad=(26, 12), anchor="l"):
    w = d.textlength(s, font=f)
    asc, desc = f.getmetrics()
    h = asc + desc
    x, y = xy
    if anchor == "c":
        x -= (w + pad[0] * 2) / 2
    d.rounded_rectangle((x, y, x + w + pad[0] * 2, y + h + pad[1] * 2), (h + pad[1] * 2) / 2, fill=bg)
    d.text((x + pad[0], y + pad[1]), s, font=f, fill=fg)
    return x + w + pad[0] * 2, y + h + pad[1] * 2


def logo(im, xy, width, label=True, anchor="l"):
    d = ImageDraw.Draw(im)
    lg = LOGO.resize((width, round(LOGO.height * width / LOGO.width)), Image.LANCZOS)
    f = font(MONT_SB, max(14, width // 7))
    cap = "Built by"
    cw = d.textlength(cap, font=f) + 14 if label else 0
    x, y = xy
    if anchor == "r":
        x -= cw + lg.width
    if anchor == "c":
        x -= (cw + lg.width) / 2
    x = round(x)
    if label:
        d.text((x, y + lg.height // 2), cap, font=f, fill=(255, 255, 255, 220), anchor="lm")
    im.alpha_composite(lg, (x + round(cw), y))


def save(im, name):
    out = HERE / f"{name}.jpg"
    im.convert("RGB").save(out, quality=92)
    print(out, im.size)


# 1. Instagram 1080 x 1350: floodlit ground, phone rising from the bottom
def instagram():
    W, H = 1080, 1350
    im = cover(HERE / "gemini/instagram.jpg", W, H)
    shade(im, (0, 0, W, 620), 240, 60)
    shade(im, (0, 900, W, H), 0, 200)
    d = ImageDraw.Draw(im)
    c, pad = crest(150)
    im.alpha_composite(c, (W // 2 - c.width // 2, 40 - pad + 20))
    pill(d, (W / 2, 238), "NEW  ·  THE OFFICIAL APP", font(MONT_B, 24), anchor="c")
    text(d, (W / 2, 300), "LOUGHOR RFC", font(OSWALD, 118), anchor="ma")
    text(d, (W / 2, 432), "IN YOUR POCKET", font(OSWALD, 74), fill=GOLD, anchor="ma")
    text(d, (W / 2, 535), "Members' card · Tap at the bar · Club news", font(MONT_SB, 30), anchor="ma")
    p = phone("1-card.png", 440)
    put_shadowed(im, p.crop((0, 0, p.width, H - 625)), (W // 2 - p.width // 2, 625))
    shade(im, (0, H - 170, W, H - 90), 0, 225)
    shade(im, (0, H - 90, W, H), 225, 240)
    d = ImageDraw.Draw(im)
    pill(d, (50, H - 100), "Get it on Google Play", font(MONT_B, 28), bg=WHITE, fg=DEEP)
    logo(im, (W - 50, H - 86), 210, anchor="r")
    save(im, "instagram-1080x1350")


# 2. Facebook 1080 x 1080: the clubhouse bar
def facebook():
    W = H = 1080
    im = cover(HERE / "gemini/facebook.jpg", W, H)
    shade(im, (0, 0, 640, H), 240, 0, horizontal=True)
    shade(im, (0, 0, W, 330), 200, 0)
    d = ImageDraw.Draw(im)
    c, pad = crest(170)
    im.alpha_composite(c, (60 - pad, 60 - pad))
    text(d, (60, 270), "TAP.", font(OSWALD, 150))
    text(d, (60, 430), "SHOW.", font(OSWALD, 150))
    text(d, (60, 590), "SAVE.", font(OSWALD, 150), fill=GOLD)
    text(d, (64, 788), "Loughor RFC members' card\nis now on your phone.", font(MONT_SB, 34), spacing=10)
    pill(d, (60, 920), "Get it on Google Play", font(MONT_B, 28), bg=WHITE, fg=DEEP)
    p = phone("1-card.png", 400)
    put_shadowed(im, p.crop((0, 0, p.width, H - 300)), (620, 300))
    logo(im, (W - 40, 40), 200, anchor="r")
    save(im, "facebook-1080x1080")


# 3. Threads 1080 x 1350: ball on the halfway line, club news
def threads():
    W, H = 1080, 1350
    im = cover(HERE / "gemini/threads.jpg", W, H, bright=0.9)
    shade(im, (0, 0, W, 620), 245, 40)
    shade(im, (0, 620, W, H), 40, 170)
    d = ImageDraw.Draw(im)
    c, pad = crest(120)
    im.alpha_composite(c, (60 - pad, 56 - pad))
    text(d, (200, 82), "Loughor RFC", font(MONT_B, 38))
    text(d, (200, 130), "The Blues · Est. 1882", font(MONT, 26), fill=(255, 255, 255, 210))
    lines(d, (60, 220), ["NEVER MISS", "A KICK-OFF."], font(OSWALD, 120), 135, {1: GOLD})
    text(d, (62, 520), "Fixtures, match-day news and offers,\nstraight to members' phones.", font(MONT_SB, 32), spacing=10)
    p = phone("2-news.png", 430)
    put_shadowed(im, p.crop((0, 0, p.width, H - 660)), (W - p.width - 70, 660))
    d = ImageDraw.Draw(im)
    pill(d, (60, H - 200), "Get it on Google Play", font(MONT_B, 28), bg=GOLD, fg=DEEP)
    logo(im, (60, H - 90), 200)
    save(im, "threads-1080x1350")


# 4. LinkedIn 1200 x 627: the River Loughor at dusk; the business story
def linkedin():
    W, H = 1200, 627
    im = cover(HERE / "gemini/linkedin.jpg", W, H)
    shade(im, (0, 0, 760, H), 245, 30, horizontal=True)
    d = ImageDraw.Draw(im)
    logo(im, (50, 44), 190, label=False)
    pill(d, (50, 108), "CLIENT LAUNCH", font(MONT_B, 20))
    text(d, (50, 168), "Loughor RFC goes digital", font(OSWALD, 64))
    text(d, (52, 262), "A branded members' app for a\ncommunity rugby club, est. 1882.", font(MONT_SB, 28), spacing=8)
    f = font(MONT, 23)
    y = 368
    for line in ["Members' card with NFC tap and QR", "Apple and Google Wallet passes", "Linked to the Vesopa EPOS till", "Club news and fixture alerts"]:
        d.ellipse((54, y + 8, 66, y + 20), fill=GOLD)
        text(d, (82, y), line, f, shadow=False)
        y += 40
    text(d, (52, 548), "Android · Wear OS · iPhone · Apple Watch", font(MONT_SB, 20), fill=GOLD, shadow=False)
    p = phone("1-card.png", 250)
    px = W - p.width - 50
    put_shadowed(im, p.crop((0, 0, p.width, H - 190)), (px, 190))
    c, pad = crest(160)
    im.alpha_composite(c, (px + p.width // 2 - c.width // 2, 18 - pad))
    save(im, "linkedin-1200x627")


# 5. X 1600 x 900: lineout under the lights
def x_post():
    W, H = 1600, 900
    im = cover(HERE / "gemini/x.jpg", W, H)
    shade(im, (0, 0, 1000, H), 245, 0, horizontal=True)
    d = ImageDraw.Draw(im)
    c, pad = crest(150)
    im.alpha_composite(c, (70 - pad, 60 - pad))
    text(d, (250, 92), "Loughor RFC", font(MONT_B, 40))
    text(d, (250, 144), "Official app · now on Google Play", font(MONT, 28), fill=GOLD)
    lines(d, (70, 255), ["THE BLUES", "HAVE AN APP."], font(OSWALD, 112), 128, {1: GOLD})
    text(d, (72, 600), "Your members' card, your discount\nand every fixture, on your phone.", font(MONT_SB, 34), spacing=10)
    pill(d, (70, 750), "Get it on Google Play", font(MONT_B, 30), bg=WHITE, fg=DEEP)
    logo(im, (W - 60, H - 80), 230, anchor="r")
    p = phone("1-card.png", 360)
    put_shadowed(im, p.crop((0, 0, p.width, H - 190)), (800, 190))
    save(im, "x-1600x900")


if __name__ == "__main__":
    instagram(); facebook(); threads(); linkedin(); x_post()
