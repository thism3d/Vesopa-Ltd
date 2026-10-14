"""Draw Ponty Kicks' icon and share card (2026-10-15).

    python PontardaweRFC/website/tool/make_game_icon.py

  public/img/ponty-kicks.svg        the icon, crisp at any size (menu, home band)
  public/img/ponty-kicks-512.png    and as pictures: 512, 192, 32 (tab icon on /play)
  public/img/og-play.jpg            1200x630 share card for /play

The icon: the club's red, the posts, and a ball going over them with a gold
trail, with a small crest on the share card. Lettering is Permanent Marker
(Apache 2.0) and Oswald (OFL), from tool/fonts.
"""
import math
import pathlib

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE.parent
OUT = SITE / "public" / "img"
CREST = SITE.parent / "brand" / "crest.png"

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Ponty Kicks">
  <defs>
    <linearGradient id="pk-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8312f"/><stop offset=".55" stop-color="#a30d0d"/><stop offset="1" stop-color="#4a0000"/></linearGradient>
    <linearGradient id="pk-trail" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#f2c14e" stop-opacity="0"/><stop offset="1" stop-color="#f2c14e"/></linearGradient>
    <radialGradient id="pk-glow" cx=".72" cy=".28" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#pk-bg)"/>
  <rect width="128" height="128" rx="28" fill="url(#pk-glow)"/>
  <path d="M10 112 H118" stroke="#2e8b3e" stroke-width="10" stroke-linecap="round" opacity=".9"/>
  <g stroke="#fff" stroke-linecap="round" fill="none">
    <path d="M44 110 V22 M84 110 V22" stroke-width="7"/>
    <path d="M44 70 H84" stroke-width="7"/>
  </g>
  <path d="M44 110 V96 M84 110 V96" stroke="#f2c14e" stroke-width="10" stroke-linecap="round"/>
  <path d="M18 104 Q 40 70 64 46" stroke="url(#pk-trail)" stroke-width="6" stroke-linecap="round" fill="none"/>
  <g transform="translate(66 44) rotate(-35)">
    <ellipse rx="10" ry="15" fill="#fff" stroke="#5a0000" stroke-width="2.5"/>
    <path d="M0 -10 V10 M-4 -5 H4 M-4 0 H4 M-4 5 H4" stroke="#c41414" stroke-width="2" stroke-linecap="round"/>
  </g>
</svg>
"""


def draw_icon(size):
    """The same picture as the SVG, drawn at size x size."""
    k = size / 128
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # background gradient
    bg = Image.new("RGBA", (size, size))
    px = bg.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)
            a, b, c = (232, 49, 47), (163, 13, 13), (74, 0, 0)
            if t < 0.55:
                u = t / 0.55
                col = tuple(round(a[i] + (b[i] - a[i]) * u) for i in range(3))
            else:
                u = (t - 0.55) / 0.45
                col = tuple(round(b[i] + (c[i] - b[i]) * u) for i in range(3))
            px[x, y] = col + (255,)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=round(28 * k), fill=255)
    img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)
    w = lambda v: max(1, round(v * k))
    d.line([(10 * k, 112 * k), (118 * k, 112 * k)], fill=(46, 139, 62, 230), width=w(10))
    for x in (44, 84):
        d.line([(x * k, 110 * k), (x * k, 22 * k)], fill=(255, 255, 255), width=w(7))
        d.line([(x * k, 110 * k), (x * k, 96 * k)], fill=(242, 193, 78), width=w(10))
    d.line([(44 * k, 70 * k), (84 * k, 70 * k)], fill=(255, 255, 255), width=w(7))
    # trail
    pts = [(18 + (64 - 18) * t, 104 - 58 * t - 12 * math.sin(t * math.pi)) for t in [i / 20 for i in range(21)]]
    for i in range(len(pts) - 1):
        a = round(255 * i / len(pts))
        d.line([(pts[i][0] * k, pts[i][1] * k), (pts[i + 1][0] * k, pts[i + 1][1] * k)], fill=(242, 193, 78, a), width=w(6))
    # ball
    ball = Image.new("RGBA", (round(40 * k), round(40 * k)), (0, 0, 0, 0))
    bd = ImageDraw.Draw(ball)
    cx = cy = 20 * k
    bd.ellipse((cx - 10 * k, cy - 15 * k, cx + 10 * k, cy + 15 * k), fill=(255, 255, 255), outline=(90, 0, 0), width=w(2.5))
    bd.line([(cx, cy - 10 * k), (cx, cy + 10 * k)], fill=(196, 20, 20), width=w(2))
    for dy in (-5, 0, 5):
        bd.line([(cx - 4 * k, cy + dy * k), (cx + 4 * k, cy + dy * k)], fill=(196, 20, 20), width=w(2))
    ball = ball.rotate(35, resample=Image.BICUBIC)
    img.alpha_composite(ball, (round(66 * k - 20 * k), round(44 * k - 20 * k)))
    return img


def share():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        for x in range(W):
            t = x / W
            g = max(0, 1 - math.hypot(x - 950, y - 120) / 900)
            px[x, y] = (round(26 + 120 * (1 - t) * 0.6 + 60 * g), round(4 + 10 * g), round(6 + 8 * g))
    d = ImageDraw.Draw(img)
    # a pitch at the bottom
    d.rectangle((0, 520, W, H), fill=(27, 77, 33))
    for i in range(8):
        d.line([(0, 520 + i * 14), (W, 520 + i * 14)], fill=(31, 90, 38), width=6)
    icon = draw_icon(380)
    shadow = Image.new("RGBA", (460, 460), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((40, 50, 420, 430), radius=90, fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    img.paste(shadow, (720, 70), shadow)
    img.paste(icon, (760, 90), icon)
    brush = ImageFont.truetype(str(HERE / "fonts" / "PermanentMarker-Regular.ttf"), 124)
    oswald = ImageFont.truetype(str(HERE / "fonts" / "Oswald-Bold.ttf"), 40)
    small = ImageFont.truetype(str(HERE / "fonts" / "Oswald-Medium.ttf"), 30)
    d.text((80, 96), "PONTARDAWE RFC PRESENTS", font=small, fill=(242, 193, 78))
    # brush title with a dark offset, like the posters
    for dx, dy, col in ((6, 8, (90, 0, 0)), (0, 0, (255, 255, 255))):
        d.text((74 + dx, 140 + dy), "PONTY", font=brush, fill=col)
        d.text((74 + dx, 270 + dy), "KICKS", font=brush, fill=col if col != (255, 255, 255) else (242, 193, 78))
    d.text((80, 420), "THE CONVERSION CHALLENGE · FREE TO PLAY", font=oswald, fill=(255, 235, 235))
    crest = Image.open(CREST).convert("RGBA").resize((70, 70), Image.LANCZOS)
    img.paste(crest, (80, 540), crest)
    d.text((165, 556), "pontardawerfc.com/play", font=small, fill=(255, 255, 255))
    img.save(OUT / "og-play.jpg", quality=86, optimize=True, progressive=True)


def main():
    (OUT / "ponty-kicks.svg").write_text(SVG, encoding="utf-8", newline="\n")
    for size in (512, 192, 32):
        draw_icon(size).save(OUT / f"ponty-kicks-{size}.png", optimize=True)
    share()
    print("icon and share card written")


if __name__ == "__main__":
    main()
