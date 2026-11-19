"""Draw the site's pictures from the club crest.

    python LoughorRFC/website/tool/make_images.py

Needs Pillow. Reads LoughorRFC/brand/crest.png, writes public/img/. Re-run after a new crest or photo;
the output is committed, so the server needs no image tools.

  icons      favicon.ico, icon-192/512, maskable-512, apple-touch-icon
  crest      crest-512.png, crest-256.webp, crest-128.webp (the opening animation)
  panels     club panels (banner, clubhouse, history) as .webp and .jpg
  share      og-<page>.jpg, 1200x630, crest on the club's blue with the page's title
"""
import json
import pathlib

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE.parent
CREST = SITE.parent / "brand" / "crest.png"
ORIGINAL = SITE / "content" / "images" / "original"
OUT = SITE / "public" / "img"
FONTS = HERE / "fonts"

RED = (18, 56, 168)
DEEP = (7, 26, 82)
GOLD = (245, 197, 24)
GLOW = (47, 98, 224)

PANELS = {
    # name on the site: (width, height, kicker, title, alt). The club has no
    # photos on file yet: these are drawn club panels until it sends some.
    "banner": (1500, 500, "THE BLUES  ·  EST. 1882", "LOUGHOR RFC", "Loughor RFC, the Blues, established 1882"),
    "clubhouse": (640, 480, "VILLA FIELD  ·  BELGRAVE ROAD", "THE CLUBHOUSE", "The Loughor RFC clubhouse at Villa Field"),
    "history": (640, 438, "HONOURS", "WEST WALES CUP 1952-53\nWEST WALES CHAMPIONS 1953-54", "Loughor RFC honours: West Wales Cup and West Wales Championship"),
}

SHARE = {
    "home": ("Loughor RFC", "The Blues of Loughor, playing rugby since 1882"),
    "club": ("The Club", "Loughor rugby since 1882"),
    "teams": ("Teams & Fixtures", "First XV, juniors and match days"),
    "news": ("Club News", "The latest from Villa Field"),
    "clubhouse": ("The Clubhouse", "Bar, food, live sport and functions"),
    "menu": ("Menu & Order", "Order to your table or for collection"),
    "membership": ("Membership", "Your members' card at member.loughorrfc.site"),
    "contact": ("Contact", "Belgrave Road, Loughor SA4 6RF"),
}


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def gradient(w, h):
    """The club's royal blue, deepening to navy, with a glow top right."""
    img = Image.new("RGB", (w, h), DEEP)
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = (x / w) * 0.45 + (y / h) * 0.55
            r = int(RED[0] * (1 - t) + DEEP[0] * t)
            g = int(RED[1] * (1 - t) + DEEP[1] * t)
            b = int(RED[2] * (1 - t) + DEEP[2] * t)
            px[x, y] = (r, g, b)
    glow = Image.new("L", (w, h), 0)
    ImageDraw.Draw(glow).ellipse((int(w * 0.55), int(-h * 0.5), int(w * 1.35), int(h * 0.75)), fill=150)
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    img.paste(Image.new("RGB", (w, h), GLOW), (0, 0), glow)
    # Faint stripes for texture.
    hoops = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(hoops)
    for i in range(-h, w, 90):
        d.polygon([(i, h), (i + 40, h), (i + 40 + h, 0), (i + h, 0)], fill=14)
    img.paste(Image.new("RGB", (w, h), (255, 255, 255)), (0, 0), hoops)
    return img


def crest():
    """The club's own crest (Leucarum · Loughor R.F.C.), exactly as the club
    supplies it: never redrawn, recoloured or replaced (owner, 2026-11-18:
    "Keep their branding")."""
    if not CREST.is_file():
        raise SystemExit(f"! no crest at {CREST}: save the club's own crest file there first")
    return Image.open(CREST).convert("RGBA")


def square(c, size, pad=0.0):
    """The crest alone, no background: cropped to itself and centred in a
    transparent square, so it fills a browser tab (the owner, 2026-10-15)."""
    tight = c.crop(c.split()[3].getbbox())
    room = round(size * (1 - 2 * pad))
    scale = room / max(tight.size)
    fit = tight.resize((max(1, round(tight.width * scale)), max(1, round(tight.height * scale))), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(fit, ((size - fit.width) // 2, (size - fit.height) // 2), fit)
    return out


def icons():
    c = crest()
    for size in (192, 512):
        square(c, size, 0.02).save(OUT / f"icon-{size}.png", optimize=True)
    # Maskable (Android's installed app only): the crest inside the safe zone, on the club's red.
    m = Image.new("RGBA", (512, 512), RED + (255,))
    inner = c.resize((340, 340), Image.LANCZOS)
    m.paste(inner, (86, 86), inner)
    m.save(OUT / "maskable-512.png", optimize=True)
    # Safari on an iPad shows this in its tabs and favourites: the crest
    # alone, transparent, like every other icon.
    square(c, 180, 0.03).save(OUT / "apple-touch-icon.png", optimize=True)
    ico = square(c, 64)
    ico.save(OUT.parent / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    square(c, 32).save(OUT / "favicon-32.png", optimize=True)
    square(c, 16).save(OUT / "favicon-16.png", optimize=True)
    c.resize((512, 512), Image.LANCZOS).save(OUT / "crest-512.png", optimize=True)
    for size in (256, 128):
        c.resize((size, size), Image.LANCZOS).save(OUT / f"crest-{size}.webp", quality=90, method=6)


def panels():
    c = crest()
    meta = {}
    for name, (w, h, kicker, title, alt) in PANELS.items():
        img = gradient(w, h)
        d = ImageDraw.Draw(img)
        side = int(h * 0.78)
        badge = c.resize((side, side), Image.LANCZOS)
        img.paste(badge, (w - side - int(h * 0.08), (h - side) // 2), badge)
        room = w - side - int(h * 0.2) - 40
        size = int(h * 0.16)
        while True:  # the biggest type that fits in three lines
            f = font("Oswald-Bold.ttf", size)
            lines = []
            for part in title.split("\n"):  # a new line in the title always breaks
                line = ""
                for word in part.split():
                    test = (line + " " + word).strip()
                    if d.textlength(test, font=f) > room and line:
                        lines.append(line)
                        line = word
                    else:
                        line = test
                lines.append(line)
            if size <= 20 or (len(lines) <= 4 and all(d.textlength(x, font=f) <= room for x in lines)):
                break
            size -= 2
        k = font("PlusJakartaSans-SemiBold.ttf", max(16, int(h * 0.05)))
        y = (h - (len(lines) * size * 1.15 + h * 0.1)) / 2
        d.text((40, y), kicker, font=k, fill=GOLD)
        y += h * 0.1
        for ln in lines:
            d.text((38, y), ln, font=f, fill=(255, 255, 255))
            y += size * 1.15
        img.save(OUT / f"{name}.webp", quality=84, method=6)
        img.save(OUT / f"{name}.jpg", quality=86, optimize=True, progressive=True)
        meta[name] = {"w": w, "h": h, "alt": alt}
    (SITE / "content" / "images.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def share():
    c = crest()
    for page, (title, sub) in SHARE.items():
        img = gradient(1200, 630)
        d = ImageDraw.Draw(img)
        shadow = Image.new("RGBA", (420, 420), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).ellipse((40, 60, 380, 400), fill=(0, 0, 0, 120))
        shadow = shadow.filter(ImageFilter.GaussianBlur(30))
        img.paste(shadow, (760, 120), shadow)
        badge = c.resize((380, 380), Image.LANCZOS)
        img.paste(badge, (780, 125), badge)
        d.text((80, 150), "EST. 1882  ·  THE BLUES", font=font("PlusJakartaSans-SemiBold.ttf", 26), fill=(214, 226, 255))
        size = 96 if len(title) <= 16 else 80
        d.text((76, 196), title.upper(), font=font("Oswald-Bold.ttf", size), fill=(255, 255, 255))
        y = 196 + size + 40
        words, line, lines = sub.split(), "", []
        f = font("PlusJakartaSans-SemiBold.ttf", 34)
        for w in words:
            test = (line + " " + w).strip()
            if d.textlength(test, font=f) > 620:
                lines.append(line)
                line = w
            else:
                line = test
        lines.append(line)
        for ln in lines:
            d.text((80, y), ln, font=f, fill=(232, 238, 255))
            y += 48
        d.rectangle((80, 540, 200, 546), fill=GOLD)
        d.text((80, 560), "loughorrfc.site", font=font("Oswald-Medium.ttf", 30), fill=(255, 255, 255))
        img.save(OUT / f"og-{page}.jpg", quality=86, optimize=True, progressive=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    icons()
    panels()
    share()
    print("written to", OUT)
