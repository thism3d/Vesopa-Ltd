"""The Vesopa Kitchen's customer display adverts (owner, 2026-11-19: "Add
few screens and images and real promotion banners with food and everything
for the venue, the Vesopa Kitchen").

    python vesopa_server/tool/make_kitchen_adverts.py PHOTO_DIR

Each banner is a real food photograph (Unsplash, free to use commercially
without attribution, https://unsplash.com/license; the photo ids are below)
filled to 1920x1080, darkened on the left for the words, with the venue's
name and Vesopa lime. Writes vesopa_server/tool/kitchen-adverts/*.jpg, which
tool/kitchen-display-adverts.js puts on the test venue's displays.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
FONTS = HERE.parent / "public" / "assets" / "fonts"
OUT = HERE / "kitchen-adverts"
W, H = 1920, 1080
LIME = (165, 199, 21)

# photo id, file name, kicker, headline, line
BANNERS = [
    ("1568901346375-23c9450c58cd", "01-cheeseburger", "MADE TO ORDER", "The Cheeseburger", "Make it a meal: chips or a side, and a drink."),
    ("1565299624946-b28f40a0ae38", "02-pizza", "HOT FROM THE OVEN", "Stone-baked pizza", "Thin, crisp and loaded. Share one, or don't."),
    ("1546069901-ba9599a7e63c", "03-bowls", "FRESH TODAY", "Fresh bowls", "Light, bright and full of flavour."),
    ("1544025162-d76694265947", "04-ribs", "SLOW COOKED", "Sticky ribs", "Smoky, tender and made for sharing."),
    ("1571091718767-18b5b1457add", "05-chicken-burger", "BURGERS", "Chicken, beef or veggie", "Every burger, with chips, sweet potato fries or onion rings."),
    ("1567620905732-2d1ec7ab7445", "06-brunch", "ALL MORNING", "Brunch stacks", "Pancakes, syrup and a proper coffee."),
    ("1514362545857-3bc16c4c7d1b", "07-drinks", "AT THE BAR", "Drinks and cocktails", "Ask at the bar for tonight's specials."),
    ("1551024601-bec78aea704b", "08-sweet", "SOMETHING SWEET", "Save room for dessert", "Treats from the counter, all day."),
    ("1504674900247-0877df9cc836", "09-order", "ORDER YOUR WAY", "Scan, order, relax", "Order from your table with your phone, or at the counter."),
]


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def cover(im, w, h):
    s = max(w / im.width, h / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def wrap(d, text, f, width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if d.textlength(trial, font=f) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line]


def banner(photo, kicker, headline, line):
    im = cover(Image.open(photo).convert("RGB"), W, H)
    # A soft dark wash from the left, so the words read on any photo.
    shade = Image.new("L", (W, H))
    sd = ImageDraw.Draw(shade)
    for x in range(W):
        t = min(1.0, max(0.0, 1.25 - x / (W * 0.66)))
        sd.line([(x, 0), (x, H)], fill=round(238 * t ** 1.1))
    im = Image.composite(Image.new("RGB", (W, H), (8, 10, 6)), im, shade)
    d = ImageDraw.Draw(im)
    x = 120
    kf, hf, lf, bf = font("oswald/oswald-700.ttf", 40), font("oswald/oswald-700.ttf", 132), font("inter/inter-400.ttf", 44), font("oswald/oswald-700.ttf", 34)
    heads = wrap(d, headline.upper(), hf, 900)
    y = (H - (70 + len(heads) * 150 + 56 + 2 * 58)) // 2
    d.rectangle((x, y + 10, x + 14, y + 44), fill=LIME)
    d.text((x + 30, y), kicker, font=kf, fill=LIME)
    y += 70
    for h in heads:
        d.text((x, y), h, font=hf, fill="white")
        y += 150
    y += 56
    for l in wrap(d, line, lf, 820)[:2]:
        d.text((x, y), l, font=lf, fill=(225, 228, 220))
        y += 58
    # The venue, bottom left.
    d.text((x, H - 110), "THE VESOPA KITCHEN", font=bf, fill="white")
    d.rectangle((x, H - 62, x + 120, H - 56), fill=LIME)
    return im


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not src or not src.is_dir():
        raise SystemExit(__doc__)
    OUT.mkdir(exist_ok=True)
    for pid, name, kicker, headline, line in BANNERS:
        im = banner(src / f"{pid}.jpg", kicker, headline, line)
        im.save(OUT / f"{name}.jpg", quality=86, optimize=True, progressive=True)
        print(f"{name}.jpg")


if __name__ == "__main__":
    main()
