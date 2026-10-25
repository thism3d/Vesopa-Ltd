"""The thumbnail for the app showcase video on the home page (2026-10-25).

    python PontardaweRFC/website/tool/make_app_video_thumb.py

1920x1080 (Full HD, as the video): the club's red, the crest, the headline,
the app's own card screen in a phone, and a play button. Written to
public/media/app-showcase.jpg and a 960px copy for phones.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SITE = Path(__file__).resolve().parents[1]
ROOT = SITE.parents[1]
FONTS = ROOT / "vesopa_express" / "assets" / "fonts"
OSWALD = SITE / "src" / "fonts" / "Oswald-Bold.ttf"
SHOT = SITE.parent / "store" / "screenshots" / "android-phone" / "1-card.png"
CREST = SITE / "public" / "img" / "crest-512.png"
OUT = SITE / "public" / "media"

W, H = 1920, 1080
RED, DEEP, GLOW = (143, 0, 0), (40, 0, 0), (196, 20, 20)


def font(path, size):
    return ImageFont.truetype(str(path), size)


def background():
    img = Image.new("RGB", (W, H), DEEP)
    px = img.load()
    for y in range(H):
        for x in range(0, W, 2):
            # A diagonal from the club's red (top left) to deep red, with a glow behind the phone.
            t = min(1, max(0, (x / W) * 0.55 + (y / H) * 0.45))
            r = int(RED[0] * (1 - t) + DEEP[0] * t)
            g = int(RED[1] * (1 - t) + DEEP[1] * t)
            b = int(RED[2] * (1 - t) + DEEP[2] * t)
            px[x, y] = (r, g, b)
            if x + 1 < W:
                px[x + 1, y] = (r, g, b)
    glow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(glow).ellipse((1080, 80, 1860, 1000), fill=150)
    glow = glow.filter(ImageFilter.GaussianBlur(160))
    img = Image.composite(Image.new("RGB", (W, H), GLOW), img, glow)
    # Two soft stripes, as on the club's site.
    over = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    d.polygon([(760, 0), (1060, 0), (560, H), (260, H)], fill=(255, 255, 255, 14))
    d.polygon([(1140, 0), (1240, 0), (740, H), (640, H)], fill=(255, 255, 255, 10))
    return Image.alpha_composite(img.convert("RGBA"), over)


def phone(img):
    shot = Image.open(SHOT).convert("RGB")
    # The store screenshot's phone, without the words above it.
    sw, sh = shot.size
    screen = shot.crop((int(sw * 0.13), int(sh * 0.19), int(sw * 0.87), int(sh * 0.985)))
    target_h = 860
    screen = screen.resize((int(screen.width * target_h / screen.height), target_h), Image.LANCZOS)
    pad, radius = 18, 56
    body = Image.new("RGBA", (screen.width + pad * 2, screen.height + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(body).rounded_rectangle((0, 0, body.width - 1, body.height - 1), radius, fill=(14, 14, 14, 255), outline=(60, 60, 60, 255), width=3)
    mask = Image.new("L", screen.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, screen.width - 1, screen.height - 1), radius - pad, fill=255)
    body.paste(screen, (pad, pad), mask)
    body = body.rotate(-6, resample=Image.BICUBIC, expand=True)
    shadow = Image.new("RGBA", body.size, (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 150), (0, 0), body.split()[3])
    shadow = shadow.filter(ImageFilter.GaussianBlur(30))
    x, y = 1170, (H - body.height) // 2 + 10
    img.alpha_composite(shadow, (x + 24, y + 34))
    img.alpha_composite(body, (x, y))
    return (x + body.width // 2, y + body.height // 2)


def play(img, centre):
    cx, cy = centre
    r = 92
    ring = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ring)
    d.ellipse((cx - r - 22, cy - r - 22, cx + r + 22, cy + r + 22), fill=(255, 255, 255, 60))
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255, 250))
    tri = [(cx - 30, cy - 46), (cx - 30, cy + 46), (cx + 48, cy)]
    d.polygon(tri, fill=RED + (255,))
    shadow = ring.filter(ImageFilter.GaussianBlur(18))
    img.alpha_composite(Image.eval(shadow, lambda v: v // 3))
    img.alpha_composite(ring)


def words(img):
    d = ImageDraw.Draw(img)
    crest = Image.open(CREST).convert("RGBA")
    crest.thumbnail((150, 150), Image.LANCZOS)
    img.alpha_composite(crest, (120, 110))
    d.text((290, 140), "PONTARDAWE RFC", font=font(OSWALD, 46), fill=(255, 255, 255))
    d.text((292, 196), "EST. 1881", font=font(FONTS / "Montserrat-Bold.ttf", 26), fill=(255, 210, 210))
    # The pill.
    pill = font(FONTS / "Montserrat-ExtraBold.ttf", 30)
    label = "NEW  ·  NOW ON GOOGLE PLAY"
    tw = d.textlength(label, font=pill)
    d.rounded_rectangle((120, 340, 120 + tw + 56, 400), 30, fill=(255, 255, 255))
    d.text((148, 352), label, font=pill, fill=RED)
    big = font(OSWALD, 124)
    d.text((116, 440), "THE MEMBERS'", font=big, fill=(255, 255, 255))
    d.text((116, 580), "APP IS HERE", font=big, fill=(255, 255, 255))
    sub = font(FONTS / "Montserrat-Medium.ttf", 38)
    d.text((122, 760), "Your card, club news and offers", font=sub, fill=(255, 228, 228))
    d.text((122, 812), "on your phone and your watch.", font=sub, fill=(255, 228, 228))
    cta = font(FONTS / "Montserrat-Bold.ttf", 34)
    d.text((122, 920), "▶  Watch the app tour", font=cta, fill=(255, 255, 255))


def main():
    img = background()
    centre = phone(img)
    words(img)
    play(img, centre)
    rgb = img.convert("RGB")
    OUT.mkdir(parents=True, exist_ok=True)
    rgb.save(OUT / "app-showcase.jpg", quality=84, optimize=True, progressive=True)
    rgb.resize((960, 540), Image.LANCZOS).save(OUT / "app-showcase-960.jpg", quality=82, optimize=True, progressive=True)
    print("written", OUT / "app-showcase.jpg")


if __name__ == "__main__":
    main()
