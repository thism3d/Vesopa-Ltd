"""Pontardawe RFC members' app film, 1920x1080 (App Store product page).
Frames as raw RGB on stdout for ffmpeg.

    python render_wide.py                      # all frames
    python render_wide.py --stills out.png 3 15 ...
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
REPO = Path("C:/Users/azureuser/develop/Vesopa-Ltd")
IMG = REPO / "PontardaweRFC/website/public/img"
WATCH = REPO / "PontardaweRFC/store/screenshots/watch-ultra"
W, H, FPS = 1920, 1080, 30

RED, DEEP, GLOW = (143, 0, 0), (63, 0, 0), (196, 20, 20)
OSWALD = str(REPO / "vesopa_server/public/assets/fonts/oswald/oswald-700.ttf")
INTER = str(REPO / "vesopa_server/public/assets/fonts/inter/inter-400.ttf")
INTER_B = str(REPO / "vesopa_server/public/assets/fonts/inter/inter-700.ttf")

# Scene starts (seconds), matched to the voice-over in vo2/.
S = {"intro": 0.0, "welcome": 11.2, "card": 21.0, "wallet": 30.3, "activity": 35.9,
     "news": 44.3, "venue": 51.8, "watch": 61.0, "end": 67.4}
DUR = 78.0
ORDER = list(S)


def end_of(key):
    i = ORDER.index(key)
    return S[ORDER[i + 1]] if i + 1 < len(ORDER) else DUR


# ---------- easing ----------
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease_out(x):
    return 1 - (1 - clamp(x)) ** 3


def ease_in_out(x):
    x = clamp(x)
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def ease_back(x):
    x = clamp(x)
    return 1 + 2.25 * (x - 1) ** 3 + 1.25 * (x - 1) ** 2


def ramp(t, start, length):
    return clamp((t - start) / length)


# ---------- pictures ----------
def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return m


def with_shadow(body, mask, blur=30, drop=22, strength=0.55, pad=80):
    w, h = body.size
    sprite = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    sh = Image.new("L", sprite.size, 0)
    sh.paste(mask.point(lambda a: int(a * strength)), (pad, pad + drop))
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    sprite.paste(Image.new("RGBA", sprite.size, (20, 0, 0, 255)), (0, 0), sh)
    body = body.convert("RGBA")
    body.putalpha(mask)
    sprite.alpha_composite(body, (pad, pad))
    return sprite


def phone(path, height=860):
    shot = Image.open(path).convert("RGB")
    sw = round(shot.width * height / shot.height)
    shot = shot.resize((sw, height), Image.LANCZOS)
    bezel, radius = 10, int(sw * 0.115)
    w, h = sw + 2 * bezel, height + 2 * bezel
    body = Image.new("RGB", (w, h), (16, 10, 10))
    body.paste(shot, (bezel, bezel), rounded_mask((sw, height), radius))
    ImageDraw.Draw(body).rounded_rectangle((1, 1, w - 2, h - 2), radius=radius + bezel, outline=(70, 50, 50), width=2)
    return with_shadow(body, rounded_mask((w, h), radius + bezel))


def watch(paths, scale=1.02):
    screens = [Image.open(p).convert("RGB") for p in paths]
    sw, sh = round(screens[0].width * scale), round(screens[0].height * scale)
    case, radius = 30, int(sw * 0.24)
    cw, ch = sw + 2 * case, sh + 2 * case
    strap_w, strap_len = int(cw * 0.66), 320
    total_w, total_h = cw + 40, ch + 2 * strap_len
    base = Image.new("RGBA", (total_w, total_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    sx = (total_w - strap_w) // 2
    for y0, y1 in ((0, strap_len + 60), (total_h - strap_len - 60, total_h)):
        strap = Image.new("RGBA", (strap_w, y1 - y0), (0, 0, 0, 0))
        sd = ImageDraw.Draw(strap)
        for x in range(strap_w):
            k = abs(x - strap_w / 2) / (strap_w / 2)
            v = int(46 - 18 * k ** 2)
            sd.line([(x, 0), (x, y1 - y0)], fill=(v + 8, v - 14, v - 14, 255))
        base.alpha_composite(strap, (sx, y0))
    cy = strap_len + ch // 2 - 110
    d.rounded_rectangle((cw - 10, cy, cw + 28, cy + 100), radius=14, fill=(70, 62, 62, 255))
    d.rounded_rectangle((cw - 10, cy + 145, cw + 16, cy + 235), radius=11, fill=(60, 54, 54, 255))
    d.rounded_rectangle((0, strap_len, cw - 1, strap_len + ch - 1), radius=radius + case, fill=(34, 30, 30, 255))
    d.rounded_rectangle((3, strap_len + 3, cw - 4, strap_len + ch - 4), radius=radius + case - 3, outline=(95, 85, 85, 255), width=3)
    d.rounded_rectangle((case - 8, strap_len + case - 8, case + sw + 8, strap_len + case + sh + 8), radius=radius + 8, fill=(0, 0, 0, 255))
    body = with_shadow(base, base.getchannel("A"), blur=36, drop=26, strength=0.6)
    faces = []
    for scr in screens:
        s = scr.resize((sw, sh), Image.LANCZOS).convert("RGBA")
        s.putalpha(rounded_mask((sw, sh), radius))
        faces.append(s)
    # where the face sits inside the shadowed sprite
    return body, faces, (80 + case, 80 + strap_len + case)


def poster(path, size, angle):
    p = Image.open(path).convert("RGB")
    side = min(p.size)
    p = p.crop(((p.width - side) // 2, 0, (p.width - side) // 2 + side, side)).resize((size, size), Image.LANCZOS)
    card = with_shadow(p, rounded_mask((size, size), 22), blur=24, drop=18, strength=0.6, pad=60)
    return card.rotate(angle, resample=Image.BICUBIC, expand=True)


def crest(size):
    c = Image.open(REPO / "PontardaweRFC/brand/crest.png").convert("RGBA").resize((size, size), Image.LANCZOS)
    pad = 60
    out = Image.new("RGBA", (size + 2 * pad, size + 2 * pad), (0, 0, 0, 0))
    g = Image.new("L", out.size, 0)
    g.paste(c.getchannel("A"), (pad, pad + 14))
    g = g.filter(ImageFilter.GaussianBlur(24)).point(lambda a: int(a * 0.6))
    out.paste(Image.new("RGBA", out.size, (25, 0, 0, 255)), (0, 0), g)
    out.alpha_composite(c, (pad, pad))
    return out


def text_line(text, font_path, size, fill=(255, 255, 255), tracking=0):
    font = ImageFont.truetype(font_path, size)
    widths = [font.getlength(c) for c in text]
    total = sum(widths) + tracking * max(0, len(text) - 1)
    asc, desc = font.getmetrics()
    img = Image.new("RGBA", (int(total) + 20, asc + desc + 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = 10
    for c, w in zip(text, widths):
        d.text((x, 8), c, font=font, fill=fill)
        x += w + tracking
    return img


def wrap(text, font, width):
    words, lines, line = text.split(), [], ""
    for w in words:
        trial = (line + " " + w).strip()
        if font.getlength(trial) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = w
    lines.append(line)
    return lines


def text_block(title, sub, width=700):
    """Accent bar, headline, one quiet line under it; left-aligned."""
    tf = ImageFont.truetype(OSWALD, 100)
    sf = ImageFont.truetype(INTER, 36)
    tl, sl = wrap(title.upper(), tf, width), wrap(sub, sf, width - 40)
    h = 30 + len(tl) * 116 + 26 + len(sl) * 50 + 20
    img = Image.new("RGBA", (width + 40, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle((4, 0, 90, 6), fill=(255, 255, 255, 235))
    y = 22
    for line in tl:
        d.text((0, y), line, font=tf, fill=(255, 255, 255))
        y += 116
    y += 26
    for line in sl:
        d.text((4, y), line, font=sf, fill=(255, 222, 222))
        y += 50
    return img


def photo_bg(path, focus_y=0.5):
    p = Image.open(path).convert("RGB")
    scale = max(W * 1.12 / p.width, H * 1.12 / p.height)
    p = p.resize((round(p.width * scale), round(p.height * scale)), Image.LANCZOS).filter(ImageFilter.GaussianBlur(3))
    x = (p.width - int(W * 1.12)) // 2
    y = int((p.height - int(H * 1.12)) * focus_y)
    p = p.crop((x, y, x + int(W * 1.12), y + int(H * 1.12)))
    # The club's red over it, darker at the edges.
    tint = Image.new("RGB", p.size)
    d = ImageDraw.Draw(tint)
    for yy in range(p.height):
        k = yy / (p.height - 1)
        d.line([(0, yy), (p.width, yy)], fill=tuple(round(a + (b - a) * k) for a, b in zip((120, 0, 0), (40, 0, 0))))
    p = Image.blend(p, tint, 0.68)
    vign = Image.new("L", p.size, 0)
    ImageDraw.Draw(vign).ellipse((-p.width * 0.15, -p.height * 0.3, p.width * 1.15, p.height * 1.3), fill=255)
    vign = vign.filter(ImageFilter.GaussianBlur(160))
    dark = Image.new("RGB", p.size, (25, 0, 0))
    dark.paste(p, (0, 0), vign)
    return dark


# ---------- background ----------
def make_background():
    bg = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(bg)
    for x in range(W):
        k = x / (W - 1)
        d.line([(x, 0), (x, H)], fill=tuple(round(a + (b - a) * k) for a, b in zip(DEEP, RED)))
    glow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(glow).ellipse((W * 0.45, -H * 0.4, W * 1.25, H * 1.1), fill=130)
    glow = glow.filter(ImageFilter.GaussianBlur(240))
    bg.paste(Image.new("RGB", (W, H), GLOW), (0, 0), glow)
    return bg.convert("RGBA")


def make_circles():
    layer = Image.new("RGBA", (W + 500, H + 500), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for cx, cy, r, a in [(300, 260, 380, 14), (1500, 300, 520, 12), (1050, 1150, 430, 12),
                         (2150, 1100, 400, 13), (150, 1250, 300, 10)]:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255, a))
    return layer


# ---------- compositing ----------
def faded(img, alpha):
    if alpha >= 0.999:
        return img
    out = img.copy()
    out.putalpha(img.getchannel("A").point(lambda v: int(v * alpha)))
    return out


def place(frame, img, cx, cy, alpha=1.0, scale=1.0, anchor="c"):
    if alpha <= 0.003:
        return
    if abs(scale - 1) > 0.002:
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.BILINEAR)
    img = faded(img, alpha)
    x = round(cx - img.width / 2) if anchor == "c" else round(cx)
    y = round(cy - img.height / 2)
    l, t = max(0, -x), max(0, -y)
    r, b = min(img.width, W - x), min(img.height, H - y)
    if r <= l or b <= t:
        return
    frame.alpha_composite(img.crop((l, t, r, b)), (x + l, y + t))


class Film:
    def __init__(self):
        s = HERE / "screens"
        self.bg = make_background()
        self.circles = make_circles()
        self.photo_in = photo_bg(IMG / "squad-2024.jpg", 0.45)
        self.photo_out = photo_bg(IMG / "squad-pitch.jpg", 0.5)
        self.ph = {
            "welcome": phone(s / "iphone-6.9-6-welcome.png", 800),
            "signin": phone(s / "iphone-6.9-5-sign-in.png", 860),
            "card": phone(s / "card-clean.png"),
            "activity": phone(s / "iphone-6.9-2-activity.png"),
            "news": phone(s / "iphone-6.9-3-news.png"),
            "venue": phone(s / "iphone-6.9-4-venue.png"),
        }
        self.watch, self.faces, self.face_at = watch([WATCH / f for f in
                                                      ("1-card.png", "2-points.png", "3-membership.png", "4-news.png")])
        ig = IMG / "ig"
        self.posters = [poster(ig / "home-v-banwen.jpg", 330, 7), poster(ig / "oktoberfest-lineup.jpg", 330, -6),
                        poster(ig / "starting-xv-briton-ferry.jpg", 300, -9)]
        self.copy = {
            "welcome": text_block("Welcome to the club", "Sign in with Apple, Google, a passkey or a code."),
            "card": text_block("Your card, on your phone", "Show the code at the bar. Your discount, every time."),
            "wallet": text_block("Always one tap away", "Add your card to Apple Wallet."),
            "activity": text_block("Earn on every visit", "Spent, earned and saved, all in one place."),
            "news": text_block("Club news, first", "Match days, fixtures and events."),
            "venue": text_block("Never miss a game", "Notifications, plus the club's website, phone and email."),
            "watch": text_block("On your wrist", "Your card and points on Apple Watch."),
        }
        self.crest_in = crest(300)
        self.crest_out = crest(250)
        self.name = text_line("PONTARDAWE RFC", OSWALD, 110, tracking=5)
        self.name_out = text_line("PONTARDAWE RFC", OSWALD, 96, tracking=5)
        self.tag = text_line("MEMBERS' APP  ·  EST. 1881", INTER_B, 30, fill=(255, 215, 215), tracking=6)
        self.bar = Image.new("RGBA", (100, 6), (255, 255, 255, 235))
        self.stores = text_line("Available on the App Store", INTER, 38, fill=(255, 235, 235))
        self.search = text_line("Search \u201cPontardawe RFC\u201d", INTER_B, 34, fill=(255, 255, 255))
        self.powered = text_line("Powered by Vesopa", INTER, 26, fill=(255, 200, 200))
        self.chip = self._chip("+23 points", "Clubhouse bar")
        self.notice = self._notice()

    def _chip(self, big, small):
        w, h = 330, 110
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=30, fill=(255, 255, 255, 255))
        d.ellipse((22, 27, 78, 83), fill=(143, 0, 0, 255))
        d.text((50, 55), "+", font=ImageFont.truetype(INTER_B, 40), fill=(255, 255, 255), anchor="mm")
        d.text((98, 20), big, font=ImageFont.truetype(INTER_B, 36), fill=(143, 0, 0))
        d.text((98, 66), small, font=ImageFont.truetype(INTER, 24), fill=(110, 90, 90))
        return with_shadow(img, img.getchannel("A"), blur=20, drop=14, strength=0.5, pad=40)

    def _notice(self):
        w, h = 600, 140
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=34, fill=(248, 244, 244, 255))
        c = Image.open(REPO / "PontardaweRFC/brand/crest.png").convert("RGBA").resize((76, 76), Image.LANCZOS)
        img.alpha_composite(c, (24, 32))
        d.text((118, 26), "Pontardawe RFC", font=ImageFont.truetype(INTER_B, 28), fill=(30, 20, 20))
        d.text((w - 30, 30), "now", font=ImageFont.truetype(INTER, 24), fill=(120, 110, 110), anchor="ra")
        d.text((118, 64), "Home game on Saturday", font=ImageFont.truetype(INTER_B, 26), fill=(40, 30, 30))
        d.text((118, 98), "Kick-off 2:30pm. The bar opens at noon.", font=ImageFont.truetype(INTER, 24), fill=(80, 70, 70))
        return with_shadow(img, img.getchannel("A"), blur=24, drop=16, strength=0.55, pad=40)

    # -- pieces --
    def background(self, t):
        f = self.bg.copy()
        ox = 250 + 90 * math.sin(t * 0.13)
        oy = 250 + 80 * math.cos(t * 0.09)
        f.alpha_composite(self.circles.crop((int(ox), int(oy), int(ox) + W, int(oy) + H)))
        return f

    def photo(self, f, img, t, start, end, alpha):
        if alpha <= 0.003:
            return
        k = ramp(t, start, end - start)
        sc = 1.0 + 0.06 * k
        cw, ch = int(W * 1.12 / sc), int(H * 1.12 / sc)
        x, y = (img.width - cw) // 2, (img.height - ch) // 2
        p = img.crop((x, y, x + cw, y + ch)).resize((W, H), Image.BILINEAR).convert("RGBA")
        f.alpha_composite(faded(p, alpha))

    def words(self, f, t, key):
        start, end = S[key], end_of(key)
        a_in = ease_out(ramp(t, start + 0.25, 0.6))
        a_out = 1 - ramp(t, end - 0.4, 0.35)
        a = min(a_in, a_out)
        place(f, self.copy[key], 170 - 50 * (1 - a_in), 540, a, anchor="l")

    def device_in_out(self, t, key, rise=True):
        """(dy, alpha, scale) for a device that rises in at the start and sinks away at the end."""
        start, end = S[key], end_of(key)
        k = ease_out(ramp(t, start, 0.9))
        o = ease_in_out(ramp(t, end - 0.45, 0.45))
        dy = (1 - k) * 700 + o * 120
        return dy, min(clamp(k * 1.6), 1 - o), 1.0 + 0.03 * ramp(t, start, end - start)

    # -- the film --
    def frame(self, t):
        f = self.background(t)
        X, Y = 1350, 560

        if t < S["welcome"] + 0.6:
            a = 1 - ease_in_out(ramp(t, S["welcome"] - 0.6, 0.9))
            self.photo(f, self.photo_in, t, 0, S["welcome"], min(ease_out(ramp(t, 0, 1.2)), a))
            out = ramp(t, S["welcome"] - 0.7, 0.6)
            ac = min(ease_out(ramp(t, 0.6, 1.0)), 1 - out)
            place(f, self.crest_in, W / 2, 370, ac, 0.86 + 0.14 * ease_back(ramp(t, 0.6, 1.2)) + 0.02 * ramp(t, 1.8, 9))
            an = min(ease_out(ramp(t, 1.6, 0.7)), 1 - out)
            place(f, self.name, W / 2, 640 + 30 * (1 - an), an)
            ab = min(ease_out(ramp(t, 2.0, 0.5)), 1 - out)
            place(f, self.bar, W / 2, 728, ab, 0.3 + 0.7 * ab)
            at = min(ease_out(ramp(t, 2.5, 0.7)), 1 - out)
            place(f, self.tag, W / 2, 785 + 20 * (1 - at), at)

        # Welcome and sign-in, side by side.
        if S["welcome"] - 0.1 <= t <= S["card"] + 0.1:
            dy, a, sc = self.device_in_out(t, "welcome")
            dy2 = (1 - ease_out(ramp(t, S["welcome"] + 0.35, 0.9))) * 700 + (dy - (1 - ease_out(ramp(t, S["welcome"], 0.9))) * 700)
            a2 = min(clamp(ease_out(ramp(t, S["welcome"] + 0.35, 0.9)) * 1.6), a if t > S["welcome"] + 1 else 1)
            place(f, self.ph["welcome"], X - 190, Y + 30 + dy, a, sc)
            place(f, self.ph["signin"], X + 200, Y + dy2, a2, sc)
            self.words(f, t, "welcome")

        # The card, then closer in for Wallet.
        if S["card"] - 0.1 <= t <= S["activity"] + 0.1:
            k = ease_out(ramp(t, S["card"], 0.9))
            z = ease_in_out(ramp(t, S["wallet"] - 0.2, 1.3))
            o = ease_in_out(ramp(t, S["activity"] - 0.45, 0.45))
            sc = 1.0 + 0.03 * ramp(t, S["card"], 9) + 0.5 * z
            dy = (1 - k) * 700 + z * 175 + o * 120
            place(f, self.ph["card"], X + 40 * z, Y + dy, min(clamp(k * 1.6), 1 - o), sc)
            self.words(f, t, "card") if t < S["wallet"] else self.words(f, t, "wallet")

        if S["activity"] - 0.1 <= t <= S["news"] + 0.1:
            dy, a, sc = self.device_in_out(t, "activity")
            place(f, self.ph["activity"], X, Y + dy, a, sc)
            c = ease_back(ramp(t, S["activity"] + 1.6, 0.6))
            ca = min(clamp(c), a)
            place(f, self.chip, X - 300, Y - 250, ca, 0.6 + 0.4 * c)
            self.words(f, t, "activity")

        if S["news"] - 0.1 <= t <= S["venue"] + 0.1:
            dy, a, sc = self.device_in_out(t, "news")
            for i, (px, py, d) in enumerate(((X - 330, Y - 180, 0.7), (X + 330, Y - 140, 0.9), (X + 350, Y + 260, 1.1))):
                pk = ease_out(ramp(t, S["news"] + d, 0.8))
                place(f, self.posters[i], px, py + (1 - pk) * 80 + dy * 0.6, min(pk, a))
            place(f, self.ph["news"], X, Y + dy, a, sc)
            self.words(f, t, "news")

        if S["venue"] - 0.1 <= t <= S["watch"] + 0.1:
            dy, a, sc = self.device_in_out(t, "venue")
            place(f, self.ph["venue"], X, Y + dy, a, sc)
            n = ease_out(ramp(t, S["venue"] + 1.4, 0.7))
            place(f, self.notice, X - 40, 150 - (1 - n) * 120 + dy * 0.5, min(n, a))
            self.words(f, t, "venue")

        if S["watch"] - 0.1 <= t <= S["end"] + 0.1:
            dy, a, sc = self.device_in_out(t, "watch")
            if a > 0.003:
                face_n = len(self.faces)
                step = (end_of("watch") - S["watch"] - 1.2) / face_n
                body = self.watch.copy()
                for i in range(face_n):
                    fa = ease_in_out(ramp(t, S["watch"] + 0.6 + i * step, 0.4)) if i else 1.0
                    if fa > 0:
                        body.alpha_composite(faded(self.faces[i], fa), self.face_at)
                place(f, body, X, Y + 10 + dy, a, sc)
            self.words(f, t, "watch")

        if t >= S["end"] - 0.3:
            k0 = S["end"]
            self.photo(f, self.photo_out, t, k0, DUR, ease_out(ramp(t, k0 - 0.3, 1.0)))
            ac = ease_out(ramp(t, k0 + 0.2, 0.9))
            place(f, self.crest_out, W / 2, 330, ac, 0.88 + 0.12 * ease_back(ramp(t, k0 + 0.2, 1.1)) + 0.02 * ramp(t, k0 + 1.3, 9))
            an = ease_out(ramp(t, k0 + 0.8, 0.7))
            place(f, self.name_out, W / 2, 565 + 26 * (1 - an), an)
            ab = ease_out(ramp(t, k0 + 1.1, 0.5))
            place(f, self.bar, W / 2, 643, ab, 0.3 + 0.7 * ab)
            a1 = ease_out(ramp(t, k0 + 1.6, 0.7))
            place(f, self.stores, W / 2, 712 + 20 * (1 - a1), a1)
            a2 = ease_out(ramp(t, k0 + 2.2, 0.7))
            place(f, self.search, W / 2, 776 + 20 * (1 - a2), a2)
            a3 = ease_out(ramp(t, k0 + 3.0, 0.8))
            place(f, self.powered, W / 2, 1000, a3 * 0.9)

        # Fade from and to black at the very ends.
        edge = min(ramp(t, 0, 0.5), 1 - ramp(t, DUR - 1.0, 1.0))
        out = f.convert("RGB")
        if edge < 0.999:
            out = Image.blend(Image.new("RGB", (W, H)), out, edge)
        return out


def main():
    film = Film()
    if len(sys.argv) >= 2 and sys.argv[1] == "--stills":
        times = [float(x) for x in sys.argv[3:]]
        cols = 3
        rows = (len(times) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * W // 3, rows * H // 3))
        for i, t in enumerate(times):
            sheet.paste(film.frame(t).resize((W // 3, H // 3)), ((i % cols) * W // 3, (i // cols) * H // 3))
        sheet.save(sys.argv[2])
        return
    stdout = sys.stdout.buffer
    first, last = 0, round(DUR * FPS)
    if len(sys.argv) >= 3 and sys.argv[1] == "--frames":
        first, last = int(sys.argv[2]), min(last, int(sys.argv[3]))
    for n in range(first, last):
        stdout.write(film.frame(n / FPS).tobytes())
        if n % 150 == 0:
            print(f"frame {n}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
