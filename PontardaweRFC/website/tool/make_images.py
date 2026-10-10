"""Draw the site's pictures from the club crest and the club's own photos.

    python PontardaweRFC/website/tool/make_images.py

Needs Pillow. Reads PontardaweRFC/brand/crest.png and
content/images/original/ (the photos saved from the club's old site,
pontardawe.rfc.wales), writes public/img/. Re-run after a new crest or photo;
the output is committed, so the server needs no image tools.

  icons      favicon.ico, icon-192/512, maskable-512, apple-touch-icon
  crest      crest-512.png, crest-256.webp, crest-128.webp (the opening animation)
  photos     each photo as .webp and .jpg at its own size (they are 640px:
             the old site only ever had small copies; never upscaled)
  share      og-<page>.jpg, 1200x630, crest on the club's red with the page's title
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

RED = (143, 0, 0)
DEEP = (40, 0, 0)
GLOW = (196, 20, 20)

PHOTOS = {
    # name on the site: (file from the old site, alt text)
    "lineout": ("image10.jpeg", "Pontardawe RFC players contest a lineout"),
    "squad-sponsor": ("image11.jpeg", "The Pontardawe RFC squad with their sponsor's banner outside the clubhouse"),
    "squad-pitch": ("image21.jpeg", "Two squads line up together on the pitch at the Recreation Ground"),
    "bones": ("image.jpg", "Brian 'Bones' Williams at the club"),
    "hiring": ("image-3.jpg", "We're hiring: join our team"),
}

SHARE = {
    "home": ("Pontardawe RFC", "Rugby in the heart of the Swansea Valley since 1881"),
    "club": ("The Club", "145 years of Pontardawe rugby"),
    "teams": ("Teams & Fixtures", "First XV, juniors and match days"),
    "news": ("Club News", "The latest from Ynysderw Road"),
    "clubhouse": ("The Clubhouse", "Bar, food, live sport and functions"),
    "menu": ("Menu & Order", "Order to your table or for collection"),
    "membership": ("Membership", "Your members' card at member.pontardawerfc.com"),
    "contact": ("Contact", "Ynysderw Road, Pontardawe SA8 4EG"),
}


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def gradient(w, h):
    """The club's red, deepening to near black, with a glow top right."""
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
    # Hoops, faint, like the shirt.
    hoops = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(hoops)
    for i in range(-h, w, 90):
        d.polygon([(i, h), (i + 40, h), (i + 40 + h, 0), (i + h, 0)], fill=14)
    img.paste(Image.new("RGB", (w, h), (255, 255, 255)), (0, 0), hoops)
    return img


def crest():
    return Image.open(CREST).convert("RGBA")


def icons():
    c = crest()
    for size in (192, 512):
        c.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png", optimize=True)
    # Maskable: the crest inside the safe zone, on the club's red.
    m = Image.new("RGBA", (512, 512), RED + (255,))
    inner = c.resize((340, 340), Image.LANCZOS)
    m.paste(inner, (86, 86), inner)
    m.save(OUT / "maskable-512.png", optimize=True)
    a = Image.new("RGBA", (180, 180), RED + (255,))
    inner = c.resize((150, 150), Image.LANCZOS)
    a.paste(inner, (15, 15), inner)
    a.convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)
    c.resize((64, 64), Image.LANCZOS).save(OUT.parent / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    c.resize((32, 32), Image.LANCZOS).save(OUT / "favicon-32.png", optimize=True)
    c.resize((512, 512), Image.LANCZOS).save(OUT / "crest-512.png", optimize=True)
    for size in (256, 128):
        c.resize((size, size), Image.LANCZOS).save(OUT / f"crest-{size}.webp", quality=90, method=6)


def photos():
    meta = {}
    for name, (file, alt) in PHOTOS.items():
        im = Image.open(ORIGINAL / file).convert("RGB")
        im.save(OUT / f"{name}.webp", quality=82, method=6)
        im.save(OUT / f"{name}.jpg", quality=84, optimize=True, progressive=True)
        meta[name] = {"w": im.width, "h": im.height, "alt": alt}
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
        d.text((80, 150), "EST. 1881  ·  SWANSEA VALLEY", font=font("PlusJakartaSans-SemiBold.ttf", 26), fill=(255, 210, 210))
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
            d.text((80, y), ln, font=f, fill=(255, 235, 235))
            y += 48
        d.rectangle((80, 540, 200, 546), fill=(255, 255, 255))
        d.text((80, 560), "pontardawerfc.com", font=font("Oswald-Medium.ttf", 30), fill=(255, 255, 255))
        img.save(OUT / f"og-{page}.jpg", quality=86, optimize=True, progressive=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    icons()
    photos()
    share()
    print("written to", OUT)
