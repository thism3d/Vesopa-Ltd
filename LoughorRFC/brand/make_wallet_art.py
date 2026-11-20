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


def crow_shape(crest):
    """The crow on top of the club's crest, as a silhouette: the crows that fly
    across the card are the club's own."""
    import numpy as np
    from scipy import ndimage
    a = np.asarray(crest).astype(float)
    luma = 0.3 * a[..., 0] + 0.59 * a[..., 1] + 0.11 * a[..., 2]
    dark = (luma < 70) & (a[..., 3] > 120)
    h = dark.shape[0]
    labels, _ = ndimage.label(dark)
    top = labels[: int(h * 0.33)]
    ids, counts = np.unique(top[top > 0], return_counts=True)
    crow = ndimage.binary_closing(labels == ids[np.argmax(counts)], iterations=2)
    ys, xs = np.nonzero(crow)
    m = Image.fromarray((crow[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1] * 255).astype("uint8"))
    return m


def scene(w, h, crest, crest_at=0.80, crest_h=0.92, crows=True, title=None, rng_seed=1882):
    """Villa Field on a match night (owner, 2026-11-20: "attractive wallet
    passes ... follow Apple guidelines"): a navy sky going to royal blue, the
    floodlights' gold glow, the posts, the pitch's mown stripes, the River
    Loughor's waves along the foot (as the website), the club's crows, and the
    crest. Drawn at three times the size and brought down, for clean edges.
    The left of the picture stays calm and dark, where Wallet puts the points."""
    import math
    import random
    S = 3
    W, H = w * S, h * S
    img = Image.new("RGBA", (W, H))
    px = img.load()
    horizon = int(H * 0.66)
    glow_x = int(W * (crest_at - 0.30)) if crest_at > 0.6 else int(W * 0.82)
    for y in range(H):
        t = y / max(1, horizon)
        for x in range(0, W):
            if y < horizon:
                base = [DEEP[i] * (1 - t) + BLUE[i] * t for i in range(3)]
                # the floodlights' warm glow, low and to the right
                dx, dy = (x - glow_x) / (W * 0.55), (y - horizon) / (H * 0.9)
                g = max(0.0, 1 - math.hypot(dx, dy)) ** 2 * 0.55
                base = [base[i] * (1 - g) + GOLD[i] * g for i in range(3)]
                # darker on the left, for the points
                dark = max(0.0, 0.35 - x / W) * 0.9
                base = [c * (1 - dark) for c in base]
                px[x, y] = tuple(int(c) for c in base) + (255,)
    d = ImageDraw.Draw(img)
    rnd = random.Random(rng_seed)
    # stars
    for _ in range(int(w * h / 2200)):
        x, y = rnd.randrange(W), rnd.randrange(int(horizon * 0.8))
        r = rnd.choice((1, 1, 2)) * S // 2 + 1
        a = rnd.randint(60, 170)
        d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 255, a))
    # the pitch, in mown stripes narrowing to the horizon
    stripes = 9
    for i in range(stripes):
        y0 = horizon + (H - horizon) * (i / stripes) ** 1.25
        y1 = horizon + (H - horizon) * ((i + 1) / stripes) ** 1.25
        c = (22, 104, 48) if i % 2 else (28, 124, 58)
        d.rectangle((0, y0, W, y1 + 1), fill=c + (255,))
    # the try line and halfway, in chalk
    d.line((0, horizon + 2 * S, W, horizon + 2 * S), fill=(235, 240, 230, 200), width=max(2, S))
    # the posts: an H, gold, its uprights tall, at the floodlights
    px0 = glow_x
    gap = int(H * 0.30)
    top = int(H * 0.10)
    bar = horizon - int(H * 0.16)
    for xx in (px0 - gap // 2, px0 + gap // 2):
        d.rectangle((xx - S, top, xx + S, horizon + S * 2), fill=(255, 238, 190, 235))
    d.rectangle((px0 - gap // 2, bar - S, px0 + gap // 2, bar + S), fill=(255, 238, 190, 235))
    # the floodlight pylons, either side
    for fx in (px0 - int(gap * 1.6), px0 + int(gap * 1.6)):
        d.line((fx, horizon, fx, int(H * 0.12)), fill=(10, 18, 50, 255), width=3 * S)
        d.rectangle((fx - 6 * S, int(H * 0.08), fx + 6 * S, int(H * 0.14)), fill=(255, 246, 214, 255))
    # the River Loughor along the foot, as on the website
    river_top = int(H * 0.88)
    d.rectangle((0, river_top, W, H), fill=(9, 34, 104, 255))
    for k, (amp, off, col) in enumerate(((6, 0, (47, 98, 224, 220)), (4, 1.7, (120, 160, 255, 150)))):
        pts = []
        for x in range(0, W + 1, 6):
            y = river_top + 4 * S + k * 7 * S + amp * S * math.sin(x / (40 * S) + off)
            pts.append((x, y))
        d.line(pts, fill=col, width=2 * S)
    # the club's crows, flying left, small and dark against the sky
    if crows:
        bird = crow_shape(CREST)
        lead = 0.40 if crest_at > 0.6 else 0.12
        for (fx, fy, size, flip) in ((lead, 0.20, 0.13, True), (lead + 0.10, 0.12, 0.10, True), (lead - 0.09, 0.30, 0.09, True)):
            bh = int(H * size)
            bw = int(bird.width * bh / bird.height)
            m = bird.resize((bw, bh), Image.LANCZOS)
            if flip:
                m = m.transpose(Image.FLIP_LEFT_RIGHT)
            ink = Image.new("RGBA", m.size, (6, 12, 34, 255))
            ink.putalpha(m.point(lambda v: int(v * 0.92)))
            img.alpha_composite(ink, (int(W * fx), int(H * fy)))
    # the crest, with a soft gold halo
    ch = int(H * crest_h)
    c = fit(crest, ch * S // S)
    c = crest.copy()
    c.thumbnail((ch, ch), Image.LANCZOS)
    cx, cy = int(W * crest_at - c.width / 2), (H - c.height) // 2
    halo = Image.new("L", (W, H), 0)
    ImageDraw.Draw(halo).ellipse((cx - ch * 0.12, cy - ch * 0.08, cx + c.width + ch * 0.12, cy + c.height + ch * 0.08), fill=150)
    from PIL import ImageFilter
    halo = halo.filter(ImageFilter.GaussianBlur(ch * 0.12))
    glowl = Image.new("RGBA", (W, H), GOLD + (0,))
    glowl.putalpha(halo.point(lambda v: int(v * 0.55)))
    img.alpha_composite(glowl)
    shadow = Image.new("RGBA", c.size, (0, 0, 0, 0))
    shadow.putalpha(c.split()[3].point(lambda v: int(v * 0.45)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(ch * 0.02))
    img.alpha_composite(shadow, (cx + int(ch * 0.015), cy + int(ch * 0.03)))
    img.alpha_composite(c, (cx, cy))
    if title:
        title(img, ImageDraw.Draw(img), S)
    return img.resize((w, h), Image.LANCZOS)


def fit(crest, size):
    c = crest.copy()
    c.thumbnail((size, size), Image.LANCZOS)
    return c


CREST = None


def main():
    global CREST
    crest = CREST = Image.open(HERE / "crest.png").convert("RGBA")
    APPLE.mkdir(parents=True, exist_ok=True)
    GOOGLE.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon.png", 29), ("icon@2x.png", 58), ("logo.png", 50), ("logo@2x.png", 100)):
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        c = fit(crest, size)
        canvas.alpha_composite(c, ((size - c.width) // 2, (size - c.height) // 2))
        canvas.save(APPLE / name, optimize=True)
    # The strip behind the points: Villa Field on a match night, the crest on
    # the right, the left kept dark for the number (Apple's Pass Designer:
    # artwork that reads behind the primary field).
    for name, (w, h) in (("strip.png", (375, 98)), ("strip@2x.png", (750, 196))):
        scene(w, h, crest).convert("RGB").save(APPLE / name, optimize=True)
    Image.open(HERE / "crest-circle.png").convert("RGBA").resize((660, 660), Image.LANCZOS).save(GOOGLE / "wallet-logo.png", optimize=True)
    scene(1032, 336, crest, crest_at=0.5, crest_h=0.88).convert("RGB").save(GOOGLE / "wallet-hero.png", optimize=True)

    # The wide logo: crest, then the name, on nothing (the card's own blue).
    wm = Image.new("RGBA", (1280, 400), (0, 0, 0, 0))
    c = fit(crest, 340)
    wm.alpha_composite(c, (20, (400 - c.height) // 2))
    d = ImageDraw.Draw(wm)
    d.text((40 + c.width + 30, 200), "Loughor RFC", font=font("Fraunces-SemiBold.ttf", 150), fill=(255, 255, 255), anchor="lm")
    wm.save(GOOGLE / "wallet-wordmark.png", optimize=True)

    # The image module: a programme-cover banner.
    def words(img, d, S):
        x = int(img.width * 0.50)
        d.text((x, int(img.height * 0.40)), "Loughor RFC", font=font("Fraunces-SemiBold.ttf", 170 * S), fill=(255, 255, 255), anchor="ls")
        d.rectangle((x + 4 * S, int(img.height * 0.46), x + 220 * S, int(img.height * 0.46) + 8 * S), fill=GOLD)
        d.text((x + 4 * S, int(img.height * 0.62)), "Villa Field \u00b7 Est. 1882", font=font("SourceSans3-SemiBold.ttf", 76 * S), fill=GOLD, anchor="ls")
        d.text((x + 4 * S, int(img.height * 0.76)), "Members' card", font=font("Fraunces-Italic.ttf", 66 * S), fill=(232, 238, 255), anchor="ls")

    ban = scene(1860, 620, crest, crest_at=0.22, crest_h=0.86, title=words)
    ban.convert("RGB").save(GOOGLE / "wallet-banner.png", optimize=True)
    print("wrote", APPLE.relative_to(ROOT), "and", GOOGLE.relative_to(ROOT))


if __name__ == "__main__":
    main()
