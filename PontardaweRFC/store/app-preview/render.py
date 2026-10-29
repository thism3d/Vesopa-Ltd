"""Pontardawe RFC App Store preview: frames as raw RGB on stdout for ffmpeg.

    python render.py [--still SECONDS out.png]
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
REPO = Path("C:/Users/azureuser/develop/Vesopa-Ltd")
W, H, FPS, DUR = 886, 1920, 30, 29.5

RED, DEEP, GLOW = (143, 0, 0), (63, 0, 0), (196, 20, 20)
OSWALD = str(REPO / "vesopa_server/public/assets/fonts/oswald/oswald-700.ttf")
INTER = str(REPO / "vesopa_server/public/assets/fonts/inter/inter-400.ttf")
INTER_B = str(REPO / "vesopa_server/public/assets/fonts/inter/inter-700.ttf")

# Scene boundaries, matched to the voice-over.
T_CARD, T_ACT, T_NEWS, T_WATCH, T_END = 4.6, 11.4, 14.6, 19.4, 23.4


# ---------- easing ----------
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease_out(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def ease_in_out(x):
    x = clamp(x)
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def ease_back(x):
    x = clamp(x)
    c1 = 1.25
    return 1 + (c1 + 1) * (x - 1) ** 3 + c1 * (x - 1) ** 2


def ramp(t, start, length):
    return clamp((t - start) / length)


# ---------- backgrounds ----------
def make_background():
    bg = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(bg)
    for y in range(H):
        k = y / (H - 1)
        d.line([(0, y), (W, y)], fill=tuple(round(a + (b - a) * k) for a, b in zip(RED, DEEP)))
    glow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(glow).ellipse((-W * 0.4, -H * 0.25, W * 1.4, H * 0.55), fill=120)
    glow = glow.filter(ImageFilter.GaussianBlur(220))
    bg.paste(Image.new("RGB", (W, H), GLOW), (0, 0), glow)
    return bg.convert("RGBA")


def make_circles():
    # The soft circles of the club's other artwork, on a layer bigger than the frame.
    layer = Image.new("RGBA", (W + 400, H + 400), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for cx, cy, r, a in [(120, 380, 430, 16), (1150, 900, 520, 13), (260, 1700, 470, 12),
                         (1080, 2150, 380, 14), (620, 120, 260, 10)]:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255, a))
    return layer.filter(ImageFilter.GaussianBlur(3))


# ---------- sprites ----------
def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return m


def with_shadow(body, mask, blur=34, drop=26, strength=0.55, pad=90):
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


def phone(path, height=1260):
    shot = Image.open(path).convert("RGB")
    sw = round(shot.width * height / shot.height)
    shot = shot.resize((sw, height), Image.LANCZOS)
    bezel, radius = 13, int(sw * 0.115)
    w, h = sw + 2 * bezel, height + 2 * bezel
    body = Image.new("RGB", (w, h), (16, 10, 10))
    body.paste(shot, (bezel, bezel), rounded_mask((sw, height), radius))
    # a hint of edge light
    ImageDraw.Draw(body).rounded_rectangle((1, 1, w - 2, h - 2), radius=radius + bezel, outline=(70, 50, 50), width=2)
    return with_shadow(body, rounded_mask((w, h), radius + bezel))


def watch(paths, scale=1.22):
    screens = [Image.open(p).convert("RGB") for p in paths]
    sw, sh = round(screens[0].width * scale), round(screens[0].height * scale)
    case, radius = 34, int(sw * 0.24)
    cw, ch = sw + 2 * case, sh + 2 * case
    strap_w, strap_len = int(cw * 0.66), 330
    total_w, total_h = cw + 40, ch + 2 * strap_len
    out = []
    for scr in screens:
        body = Image.new("RGBA", (total_w, total_h), (0, 0, 0, 0))
        d = ImageDraw.Draw(body)
        sx = (total_w - strap_w) // 2
        for y0, y1 in ((0, strap_len + 60), (total_h - strap_len - 60, total_h)):
            strap = Image.new("RGBA", (strap_w, y1 - y0), (0, 0, 0, 0))
            sd = ImageDraw.Draw(strap)
            for x in range(strap_w):
                k = abs(x - strap_w / 2) / (strap_w / 2)
                v = int(46 - 18 * k ** 2)
                sd.line([(x, 0), (x, y1 - y0)], fill=(v + 8, v - 14, v - 14, 255))
            body.alpha_composite(strap, (sx, y0))
        # the crown
        cy = strap_len + ch // 2 - 120
        d.rounded_rectangle((cw - 10, cy, cw + 30, cy + 110), radius=16, fill=(70, 62, 62, 255))
        d.rounded_rectangle((cw - 10, cy + 160, cw + 18, cy + 260), radius=12, fill=(60, 54, 54, 255))
        # the case
        d.rounded_rectangle((0, strap_len, cw - 1, strap_len + ch - 1), radius=radius + case, fill=(34, 30, 30, 255))
        d.rounded_rectangle((3, strap_len + 3, cw - 4, strap_len + ch - 4), radius=radius + case - 3, outline=(95, 85, 85, 255), width=3)
        d.rounded_rectangle((case - 8, strap_len + case - 8, case + sw + 8, strap_len + case + sh + 8), radius=radius + 8, fill=(0, 0, 0, 255))
        s = scr.resize((sw, sh), Image.LANCZOS).convert("RGBA")
        s.putalpha(rounded_mask((sw, sh), radius))
        body.alpha_composite(s, (case, strap_len + case))
        mask = body.getchannel("A")
        out.append(with_shadow(body, mask, blur=40, drop=30, strength=0.6))
    return out


def text_sprite(text, font_path, size, fill=(255, 255, 255), tracking=0):
    font = ImageFont.truetype(font_path, size)
    widths = [font.getlength(c) for c in text]
    total = sum(widths) + tracking * (len(text) - 1)
    asc, desc = font.getmetrics()
    img = Image.new("RGBA", (int(total) + 20, asc + desc + 20), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = 10
    for c, w in zip(text, widths):
        d.text((x, 10), c, font=font, fill=fill)
        x += w + tracking
    return img


def crest(size):
    c = Image.open(REPO / "PontardaweRFC/brand/crest.png").convert("RGBA").resize((size, size), Image.LANCZOS)
    pad = 60
    glow = Image.new("RGBA", (size + 2 * pad, size + 2 * pad), (0, 0, 0, 0))
    g = Image.new("L", glow.size, 0)
    g.paste(c.getchannel("A"), (pad, pad + 16))
    g = g.filter(ImageFilter.GaussianBlur(26)).point(lambda a: int(a * 0.55))
    glow.paste(Image.new("RGBA", glow.size, (25, 0, 0, 255)), (0, 0), g)
    glow.alpha_composite(c, (pad, pad))
    return glow


# ---------- compositing helpers ----------
def faded(img, alpha):
    if alpha >= 0.999:
        return img
    a = img.getchannel("A").point(lambda v: int(v * alpha))
    out = img.copy()
    out.putalpha(a)
    return out


def place(frame, img, cx, cy, alpha=1.0, scale=1.0):
    if alpha <= 0.003:
        return
    if abs(scale - 1) > 0.002:
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.BILINEAR)
    img = faded(img, alpha)
    x, y = round(cx - img.width / 2), round(cy - img.height / 2)
    # crop to the frame so alpha_composite accepts it
    l, t = max(0, -x), max(0, -y)
    r, b = min(img.width, W - x), min(img.height, H - y)
    if r <= l or b <= t:
        return
    frame.alpha_composite(img.crop((l, t, r, b)), (x + l, y + t))


# ---------- the film ----------
class Film:
    def __init__(self):
        s = HERE / "screens"
        self.bg = make_background()
        self.circles = make_circles()
        self.phones = {
            "card": phone(s / "card-clean.png"),
            "activity": phone(s / "iphone-6.9-2-activity.png"),
            "news": phone(s / "iphone-6.9-3-news.png"),
        }
        wdir = REPO / "PontardaweRFC/store/screenshots/watch-ultra"
        self.watch = watch([wdir / "1-card.png", wdir / "2-points.png"])
        self.titles = {k: text_sprite(v, OSWALD, 104, tracking=3) for k, v in {
            "card": "YOUR CARD", "activity": "EVERY VISIT", "news": "CLUB NEWS", "watch": "ON YOUR WRIST"}.items()}
        self.crest_big = crest(330)
        self.crest_end = crest(300)
        self.name = text_sprite("PONTARDAWE RFC", OSWALD, 92, tracking=4)
        self.line = Image.new("RGBA", (90, 6), (255, 255, 255, 230))
        self.tag = text_sprite("Your club, in your pocket.", INTER, 40, fill=(255, 225, 225))
        self.est = text_sprite("EST. 1881", INTER_B, 34, fill=(255, 215, 215), tracking=10)
        self.members = text_sprite("Members' app", INTER, 36, fill=(255, 225, 225))

    def background(self, t):
        f = self.bg.copy()
        ox = 200 + 60 * math.sin(t * 0.21)
        oy = 380 - 12 * t
        f.alpha_composite(self.circles.crop((int(ox), int(oy), int(ox) + W, int(oy) + H)))
        return f

    def title(self, f, key, start, end, cy=300):
        a_in = ease_out(ramp(t := self._t, start + 0.15, 0.45))
        a_out = 1 - ramp(t, end - 0.3, 0.25)
        a = min(a_in, a_out)
        dy = (1 - a_in) * 34 - (1 - a_out) * 20
        place(f, self.line, W / 2, cy - 92 + dy, a)
        place(f, self.titles[key], W / 2, cy + dy, a)

    def frame(self, t):
        self._t = t
        f = self.background(t)

        # 1. Crest and name.
        if t < T_CARD + 0.1:
            out = ramp(t, T_CARD - 0.55, 0.5)
            a = min(ease_out(ramp(t, 0.15, 0.9)), 1 - out)
            sc = 0.86 + 0.14 * ease_back(ramp(t, 0.15, 1.1)) + 0.02 * ramp(t, 1.2, 3.4)
            place(f, self.crest_big, W / 2, 720 - 60 * ease_in_out(out), a, sc)
            an = min(ease_out(ramp(t, 1.0, 0.6)), 1 - out)
            place(f, self.name, W / 2, 1010 + 30 * (1 - an) - 60 * out, an)
            al = min(ease_out(ramp(t, 1.35, 0.5)), 1 - out)
            place(f, self.line, W / 2, 1085 - 60 * out, al, 0.4 + 0.6 * al)
            at = min(ease_out(ramp(t, 1.9, 0.6)), 1 - out)
            place(f, self.tag, W / 2, 1150 + 24 * (1 - at) - 60 * out, at)

        # 2-4. Phones: the first rises in, then each pushes the last off to the left.
        scenes = [("card", T_CARD, T_ACT), ("activity", T_ACT, T_NEWS), ("news", T_NEWS, T_WATCH)]
        slide = 0.6
        for i, (key, start, end) in enumerate(scenes):
            if not (start - slide <= t <= end + slide):
                continue
            img = self.phones[key]
            cy = 1170
            if i == 0:
                k = ease_out(ramp(t, start, 0.9))
                x = W / 2
                y = cy + (1 - k) * 1100
                alpha = clamp(k * 2)
            else:
                k = ease_in_out(ramp(t, start - slide / 2, slide))
                x = W / 2 + (1 - k) * W * 1.05
                y = cy
                alpha = 1.0
            ko = ease_in_out(ramp(t, end - slide / 2, slide))
            x -= ko * W * 1.05
            push = 1.0 + 0.035 * ramp(t, start, end - start)
            place(f, img, x, y, alpha, push)
            self.title(f, key, start, end)

        # 5. The watch, card then points.
        if T_WATCH - 0.6 <= t <= T_END + 0.1:
            k = ease_in_out(ramp(t, T_WATCH - 0.3, 0.6))
            out = ramp(t, T_END - 0.5, 0.5)
            x = W / 2 + (1 - k) * W * 1.05
            sc = (0.96 + 0.05 * ramp(t, T_WATCH, T_END - T_WATCH)) * (1 - 0.12 * ease_in_out(out))
            a = 1 - out
            swap = ease_in_out(ramp(t, T_WATCH + 1.9, 0.45))
            place(f, self.watch[0], x, 1140, a * (1 - swap) if swap < 1 else 0, sc)
            if swap > 0:
                place(f, self.watch[1], x, 1140, a * swap, sc)
            self.title(f, "watch", T_WATCH, T_END)

        # 6. The end card.
        if t >= T_END - 0.2:
            a = ease_out(ramp(t, T_END - 0.1, 0.8))
            sc = 0.9 + 0.1 * ease_back(ramp(t, T_END - 0.1, 1.0)) + 0.015 * ramp(t, T_END + 1, 5)
            place(f, self.crest_end, W / 2, 760, a, sc)
            an = ease_out(ramp(t, T_END + 0.5, 0.6))
            place(f, self.name, W / 2, 1040 + 28 * (1 - an), an)
            al = ease_out(ramp(t, T_END + 0.8, 0.5))
            place(f, self.line, W / 2, 1115, al, 0.4 + 0.6 * al)
            ae = ease_out(ramp(t, T_END + 1.1, 0.6))
            place(f, self.est, W / 2, 1180 + 20 * (1 - ae), ae)
            am = ease_out(ramp(t, T_END + 1.8, 0.6))
            place(f, self.members, W / 2, 1650 + 20 * (1 - am), am * 0.85)

        return f.convert("RGB")


def main():
    film = Film()
    if len(sys.argv) >= 2 and sys.argv[1] == "--stills":
        out = Path(sys.argv[2])
        times = [float(x) for x in sys.argv[3:]]
        sheet = Image.new("RGB", (len(times) * W // 3, H // 3))
        for i, t in enumerate(times):
            sheet.paste(film.frame(t).resize((W // 3, H // 3)), (i * W // 3, 0))
        sheet.save(out)
        return
    stdout = sys.stdout.buffer
    for n in range(round(DUR * FPS)):
        stdout.write(film.frame(n / FPS).tobytes())
        if n % 60 == 0:
            print(f"frame {n}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
