"""
Every picture a venue's own phone app needs, drawn from the venue's crest.

    python vesopa_loyalty/tool/make_venue_art.py PontardaweRFC

Reads <venue>/venue.json and <venue>/brand/crest.png (a transparent PNG, the
logo the venue uploaded to Loyalty App in the back office) and writes:

  <venue>/overlay/...   files laid over a copy of vesopa_loyalty by
                        tool/make_venue_app.py: launcher icons, the Android
                        12+ and older splash screens, the notification icon,
                        the iOS AppIcon set, launch image and Watch icon, the
                        crest the animated intro opens with, the Venue tab's
                        header and the picture on an empty page
  <venue>/store/        Play icon (512), Play feature graphic (1024x500) and
                        the App Store icon (1024, no alpha)
  vesopa_server/public/assets/venues/<slug>/
                        the members' web app's favicon, home-screen icons and
                        install icons (src/venue_looks.js `art` points at them)
  <venue>/website/public/img/
                        the same icons for the club's own website, when the
                        venue has one in its folder

Run it here, in the cloud, where Pillow is; the output is committed, so the
machine that builds the app needs nothing but Python's standard library.

THE ICON IS THE CREST AND NOTHING ELSE (owner, 2026-10-12: "only the crest,
without the background gradient, transparent"). Wherever a platform lets an
icon be transparent it is: Android's launcher icons (the adaptive icon's
background layer is transparent), the Play icon, the web icons. Two places
cannot be, and get the nearest thing:

  - iOS and the App Store refuse an icon with alpha; Apple fills any
    transparency with black. So the normal iPhone icon is the crest on plain
    white -- no gradient -- and iOS 18's dark and tinted home screens get
    their own versions, which MAY be transparent: the crest on nothing, and a
    grey crest for the system to tint (Contents.json "appearances").
  - The Watch shows icons in a black circle and refuses alpha too: the crest
    on black, which on a watch face is the same as on nothing.
  - An iPhone's "Add to Home Screen" fills a transparent apple-touch-icon
    with black, so that one is on white as well.

THE CREST IS THE SAME SIZE AT EVERY STEP OF THE OPENING: 140dp tall on the
Android 12+ splash, on the older splash, on the iPhone launch screen and as
the first frame of the Flutter intro (lib/ui/venue_intro.dart). Change one and
the hand-over between the native splash and Flutter visibly jumps.
"""

import json
import math
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[2]
FONT = ROOT / "vesopa_express" / "assets" / "fonts" / "Montserrat-ExtraBold.ttf"
FONT_MEDIUM = ROOT / "vesopa_express" / "assets" / "fonts" / "Montserrat-Medium.ttf"
SERVER_ASSETS = ROOT / "vesopa_server" / "public" / "assets" / "venues"

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
SPLASH_DP = 140  # the crest's height on every splash; see the docstring
WHITE = (255, 255, 255)


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def save_png(img, path):
    """A PNG at its smallest: palette-reduced where that loses nothing visible."""
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)


class Art:
    def __init__(self, venue_dir: Path):
        self.dir = venue_dir
        self.venue = json.loads((venue_dir / "venue.json").read_text(encoding="utf-8"))
        c = self.venue["colours"]
        self.bg = hex_rgb(c["background"])
        self.deep = hex_rgb(c["deep"])
        self.glow = hex_rgb(c["glow"])
        crest = Image.open(venue_dir / "brand" / "crest.png").convert("RGBA")
        crest = crest.crop(crest.split()[3].getbbox())
        # The uploaded crest is very slightly see-through inside (alpha 224 to
        # 254 over most of the shield): on a transparent icon that lets the
        # wallpaper show through it. The inside made solid; the soft edge kept.
        r, g, b, a = crest.split()
        self.crest = Image.merge("RGBA", (r, g, b, a.point(lambda v: 255 if v >= 200 else v)))
        self.overlay = venue_dir / "overlay"
        self.store = venue_dir / "store"
        # How far the crest's farthest corner is from its middle, as a
        # fraction of its height: what sizes it inside a circle.
        alpha = self.crest.split()[3].load()
        w, h = self.crest.size
        self.reach = max(
            math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2)
            for y in range(0, h, 2) for x in range(0, w, 2) if alpha[x, y] > 40
        ) / h

    # ---- drawing ---------------------------------------------------------

    def field(self, w, h=None):
        """The club red: a glow in the middle falling away to deep red."""
        h = h or w
        small = 256
        grad = Image.new("L", (small, small))
        px = grad.load()
        for y in range(small):
            for x in range(small):
                dx = (x - small / 2) / (small / 2)
                dy = (y - small * 0.42) / (small / 2)
                px[x, y] = max(0, min(255, int(255 * (1 - min(1, (dx * dx + dy * dy) ** 0.5 / 1.25)))))
        grad = grad.resize((w, h), Image.BICUBIC)
        out = Image.composite(Image.new("RGB", (w, h), self.glow), Image.new("RGB", (w, h), self.deep), grad)
        return out.convert("RGBA")

    def crest_h(self, height):
        """The crest scaled to a height, its width following."""
        width = round(self.crest.width * height / self.crest.height)
        return self.crest.resize((width, round(height)), Image.LANCZOS)

    def in_circle(self, diameter):
        """The crest's height when all of it fits a circle of [diameter]."""
        return diameter / 2 / self.reach

    def shadow(self, img, radius, opacity=0.55, offset=(0, 0)):
        """A soft dark shadow of an image's shape, same canvas size."""
        a = img.split()[3].point(lambda v: int(v * opacity))
        sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
        sh.putalpha(a)
        pad = radius * 3
        big = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
        big.paste(sh, (pad + offset[0], pad + offset[1]), sh)
        big = big.filter(ImageFilter.GaussianBlur(radius))
        return big.crop((pad, pad, pad + img.width, pad + img.height))

    def icon(self, size, crest_height, ground=None):
        """The crest centred on a square of nothing, or of one plain colour.

        No gradient and no shadow: a shadow on a transparent icon is a grey
        smudge round the crest on a light wallpaper.
        """
        canvas = Image.new("RGBA", (size, size), (ground + (255,)) if ground else (0, 0, 0, 0))
        crest = self.crest_h(crest_height)
        canvas.alpha_composite(crest, ((size - crest.width) // 2, (size - crest.height) // 2))
        return canvas

    def silhouette(self, size, height_frac):
        """White crest for the status bar and themed icons: shape only.

        The crest's own outline as a rim, with the venue's initial inside it.
        The photographic crest has no clean shape of its own to trace -- a
        threshold of it is noise at 24px -- so the shield is the crest's
        outline and the inside is drawn. Made at 512px and scaled down.
        """
        big = 512
        crest = self.crest_h(big * height_frac)
        shield = crest.split()[3].point(lambda v: 255 if v > 128 else 0)
        rim = max(4, crest.width // 11)
        inner = shield.filter(ImageFilter.MinFilter(rim * 2 + 1))
        mark = ImageChops.subtract(shield, inner)
        letter = self.venue.get("initial") or self.venue["name"][0]
        font = ImageFont.truetype(str(FONT), int(crest.height * 0.56))
        d = ImageDraw.Draw(mark)
        box = d.textbbox((0, 0), letter, font=font)
        d.text(
            ((crest.width - (box[2] - box[0])) / 2 - box[0], (crest.height - (box[3] - box[1])) / 2 - box[1] - crest.height * 0.04),
            letter, font=font, fill=255,
        )
        out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        white = Image.new("RGBA", crest.size, (255, 255, 255, 255))
        out.paste(white, ((big - crest.width) // 2, (big - crest.height) // 2), mark)
        return out.resize((size, size), Image.LANCZOS)

    # ---- the rugby pictures ----------------------------------------------
    #
    # Posts, a ball in flight, the hoops of a jersey and the lines of a
    # pitch, in the club's colours. Drawn at twice the size and scaled down,
    # so every edge is smooth.

    @staticmethod
    def hoops(size, colour, alpha, every, width, slant=0.35):
        """Diagonal bands, like a jersey's hoops seen at an angle."""
        w, h = size
        layer = Image.new("RGBA", size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        for x0 in range(-h, w + h, every):
            d.polygon(
                [(x0, h), (x0 + width, h), (x0 + width + h * slant, 0), (x0 + h * slant, 0)],
                fill=colour + (alpha,),
            )
        return layer

    @staticmethod
    def pitch(size, horizon, colour, alpha, lines=9, width=3):
        """A pitch's touchlines running away to a horizon."""
        w, h = size
        layer = Image.new("RGBA", size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        vx = w * 0.62
        for i in range(lines):
            x = -w * 0.4 + i * (w * 1.8) / (lines - 1)
            d.line([(vx + (x - vx) * 0.08, horizon), (x, h)], fill=colour + (alpha,), width=width)
        # The cross lines, closer together as they recede.
        for i in range(1, 6):
            y = horizon + (h - horizon) * (i / 6) ** 1.7
            d.line([(0, y), (w, y)], fill=colour + (int(alpha * 0.8),), width=max(1, width - 1))
        # Fade the far end into the sky.
        fade = Image.linear_gradient("L").resize(size)
        fade = fade.point(lambda v: 0 if v < 255 * horizon / h else min(255, int((v - 255 * horizon / h) * 3)))
        layer.putalpha(ImageChops.multiply(layer.split()[3], fade))
        return layer

    @staticmethod
    def posts(size, foot, height, gap, thick, colour, alpha=255, pads=None):
        """Rugby posts: two uprights and a crossbar a third of the way up.

        [foot] is where the middle of the posts meets the ground.
        """
        layer = Image.new("RGBA", size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        fx, fy = foot
        fill = colour + (alpha,)
        for side in (-1, 1):
            x = fx + side * gap / 2
            d.rounded_rectangle((x - thick / 2, fy - height, x + thick / 2, fy), radius=thick / 2, fill=fill)
            if pads:
                d.rounded_rectangle(
                    (x - thick * 1.9, fy - height * 0.16, x + thick * 1.9, fy),
                    radius=thick * 0.6, fill=pads + (alpha,),
                )
        bar_y = fy - height * 0.34
        d.rounded_rectangle((fx - gap / 2, bar_y - thick / 2, fx + gap / 2, bar_y + thick / 2), radius=thick / 2, fill=fill)
        return layer

    @staticmethod
    def ball(length, leather, seam, angle):
        """A rugby ball side on, its seam and laces, turned to [angle] degrees."""
        w, h = int(length), int(length * 0.6)
        pad = int(length * 0.1)
        layer = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        cx, cy, a, b = pad + w / 2, pad + h / 2, w / 2, h / 2
        # Half a lens raised a little short of a square root: a ball's pointed
        # ends, where an ellipse would be an egg.
        shape = []
        for i in range(181):
            u = -1 + 2 * i / 180
            shape.append((cx + a * u, cy - b * (1 - u * u) ** 0.72))
        for i in range(181):
            u = 1 - 2 * i / 180
            shape.append((cx + a * u, cy + b * (1 - u * u) ** 0.72))
        d.polygon(shape, fill=leather + (255,))
        # The panel seams: two arcs from tip to tip.
        stroke = max(2, int(length * 0.025))
        for k in (0.42, -0.42):
            line = [(cx + a * u, cy + k * b * (1 - u * u) ** 0.9) for u in [-0.96 + 1.92 * i / 60 for i in range(61)]]
            d.line(line, fill=seam + (150,), width=stroke)
        # The laces along the top seam.
        lace_y = lambda u: cy - 0.42 * b * (1 - u * u) ** 0.9  # noqa: E731
        d.line([(cx + a * u, lace_y(u)) for u in [-0.3 + 0.6 * i / 20 for i in range(21)]], fill=seam + (255,), width=stroke)
        for i in range(6):
            u = -0.25 + 0.5 * i / 5
            x, y = cx + a * u, lace_y(u)
            d.line([(x, y - b * 0.12), (x, y + b * 0.12)], fill=seam + (255,), width=stroke)
        # A highlight, so it reads as round.
        shine = Image.new("L", layer.size, 0)
        ImageDraw.Draw(shine).ellipse((cx - a * 0.55, cy - b * 0.78, cx + a * 0.15, cy - b * 0.25), fill=70)
        shine = shine.filter(ImageFilter.GaussianBlur(length * 0.04))
        white = Image.new("RGBA", layer.size, WHITE + (0,))
        white.putalpha(ImageChops.multiply(shine, layer.split()[3]))
        layer = Image.alpha_composite(layer, white)
        return layer.rotate(angle, resample=Image.BICUBIC, expand=True)

    @staticmethod
    def flight(size, points, colour, alpha, dot):
        """The ball's path: dots along a curve, fading out behind it."""
        layer = Image.new("RGBA", size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        (x0, y0), (x1, y1), (x2, y2) = points
        n = 16
        for i in range(n):
            t = i / n
            x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * x1 + t * t * x2
            y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * y1 + t * t * y2
            r = dot * (0.45 + 0.55 * t)
            d.ellipse((x - r, y - r, x + r, y + r), fill=colour + (int(alpha * (0.25 + 0.75 * t)),))
        return layer

    def scene(self, w, h, *, crest_box=None, posts_at=0.74, ball_at=(0.66, 0.2), text_room=False):
        """The club's ground at kick-off: the shared background of the header
        and the feature graphic. Drawn at 2x; the caller scales it down."""
        W, H = w * 2, h * 2
        img = self.field(W, H)
        img = Image.alpha_composite(img, self.hoops((W, H), WHITE, 9, int(H * 0.36), int(H * 0.11)))
        horizon = int(H * 0.68)
        img = Image.alpha_composite(img, self.pitch((W, H), horizon, WHITE, 46, width=max(2, H // 260)))
        posts = self.posts(
            (W, H), (W * posts_at, horizon + H * 0.04), H * 0.6, H * 0.34, max(6, H * 0.022),
            WHITE, alpha=200 if not text_room else 92, pads=self.glow,
        )
        img = Image.alpha_composite(img, self.shadow(posts, max(2, H // 120), opacity=0.35, offset=(0, H // 160)))
        img = Image.alpha_composite(img, posts)
        bx, by = W * ball_at[0], H * ball_at[1]
        img = Image.alpha_composite(
            img,
            self.flight((W, H), [(W * 0.30, H * 0.95), (W * 0.40, H * 0.10), (bx - H * 0.08, by + H * 0.03)], WHITE, 140, H * 0.009),
        )
        ball = self.ball(H * 0.2, (250, 244, 236), self.deep, 28)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        layer.alpha_composite(ball, (int(bx - ball.width / 2), int(by - ball.height / 2)))
        img = Image.alpha_composite(img, self.shadow(layer, max(2, H // 90), opacity=0.4, offset=(0, H // 100)))
        img = Image.alpha_composite(img, layer)
        # A vignette, so the edges sit back and the middle comes forward.
        vig = Image.new("L", (W, H), 0)
        ImageDraw.Draw(vig).rectangle((0, 0, W, H), outline=255, width=int(H * 0.1))
        vig = vig.filter(ImageFilter.GaussianBlur(H * 0.12)).point(lambda v: int(v * 0.5))
        dark = Image.new("RGBA", (W, H), self.deep + (0,))
        dark.putalpha(vig)
        img = Image.alpha_composite(img, dark)
        if crest_box:
            x, cy, ch = crest_box
            crest = self.crest_h(ch * 2)
            layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            layer.alpha_composite(crest, (int(x * 2), int(cy * 2 - crest.height / 2)))
            img = Image.alpha_composite(img, self.shadow(layer, max(4, H // 50), opacity=0.6, offset=(0, H // 70)))
            img = Image.alpha_composite(img, layer)
        return img.resize((w, h), Image.LANCZOS)

    # ---- outputs ---------------------------------------------------------

    def android(self):
        res = self.overlay / "android" / "app" / "src" / "main" / "res"
        for name, scale in DENSITIES.items():
            mip = res / f"mipmap-{name}"
            mip.mkdir(parents=True, exist_ok=True)
            px = round(48 * scale)
            # Android 7: the crest as it is, on nothing.
            crest = self.icon(px, px * 0.94)
            save_png(crest, mip / "ic_launcher.png")
            save_png(crest, mip / "ic_launcher_round.png")
            # Android 8+: a 108dp canvas of which a 72dp circle or squircle
            # shows. The background layer is transparent (the XML below), and
            # the whole crest sits inside the 66dp safe circle, so no
            # launcher's mask takes a corner off the shield.
            big = round(108 * scale)
            (mip / "ic_launcher_background.png").unlink(missing_ok=True)
            save_png(self.icon(big, self.in_circle(big * 66 / 108)), mip / "ic_launcher_foreground.png")
            # Android 13 themed icons: the launcher tints this outline. Drawn
            # once and then kept, like the status-bar icon below: they are
            # settled, and a crest touched up later should not move them.
            if not (mip / "ic_launcher_monochrome.png").exists():
                self.silhouette(big, 0.54).save(mip / "ic_launcher_monochrome.png")

            draw = res / f"drawable-{name}"
            draw.mkdir(parents=True, exist_ok=True)
            # The status-bar icon: Android keeps the shape and paints it white.
            if not (draw / "ic_notification.png").exists():
                self.silhouette(round(24 * scale), 0.92).save(draw / "ic_notification.png")

        v26 = res / "mipmap-anydpi-v26"
        v26.mkdir(parents=True, exist_ok=True)
        adaptive = (
            '<?xml version="1.0" encoding="utf-8"?>\n'
            "<!-- Written by vesopa_loyalty/tool/make_venue_art.py. The crest on\n"
            "     nothing: the background layer is transparent. -->\n"
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@android:color/transparent"/>\n'
            '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
            '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n'
            "</adaptive-icon>\n"
        )
        (v26 / "ic_launcher.xml").write_text(adaptive, encoding="utf-8")
        (v26 / "ic_launcher_round.xml").write_text(adaptive, encoding="utf-8")

        # The splash crest, drawn once at xxxhdpi; Android scales it down.
        x4 = res / "drawable-xxxhdpi"
        self.crest_h(SPLASH_DP * 4).save(x4 / "splash_crest.png")
        # Android 12+: a 288dp icon of which a 192dp circle shows. The crest
        # sits inside the circle at the same 140dp.
        canvas = Image.new("RGBA", (288 * 4, 288 * 4), (0, 0, 0, 0))
        crest = self.crest_h(SPLASH_DP * 4)
        canvas.paste(crest, ((canvas.width - crest.width) // 2, (canvas.height - crest.height) // 2), crest)
        canvas.save(x4 / "splash_icon.png")

    def ios(self):
        """The iPhone icon: one 1024 image per appearance; Xcode makes the sizes.

        Any (the normal home screen) cannot have alpha, so it is the crest on
        plain white. Dark may be transparent (iOS puts its own dark behind
        it), and tinted is the crest in greys for the system to colour.
        tool/make_venue_app.py clears the app's own per-size icons first, so
        this Contents.json is the whole set.
        """
        runner = self.overlay / "ios" / "Runner" / "Assets.xcassets"
        icons = runner / "AppIcon.appiconset"
        if icons.exists():
            shutil.rmtree(icons)
        icons.mkdir(parents=True)
        size, height = 1024, 1024 * 0.80
        master = self.icon(size, height, WHITE).convert("RGB")
        dark = self.icon(size, height)
        r, g, b, a = dark.split()
        grey = ImageOps.autocontrast(Image.merge("RGB", (r, g, b)).convert("L"), cutoff=1)
        tinted = Image.merge("RGBA", (grey, grey, grey, a))
        files = {"any": "AppIcon-1024.png", "dark": "AppIcon-1024-dark.png", "tinted": "AppIcon-1024-tinted.png"}
        save_png(master, icons / files["any"])
        save_png(dark, icons / files["dark"])
        save_png(tinted, icons / files["tinted"])
        images = []
        for look, filename in files.items():
            entry = {"filename": filename, "idiom": "universal", "platform": "ios", "size": "1024x1024"}
            if look != "any":
                entry = {"appearances": [{"appearance": "luminosity", "value": look}], **entry}
            images.append(entry)
        (icons / "Contents.json").write_text(
            json.dumps({"images": images, "info": {"author": "xcode", "version": 1}}, indent=2) + "\n", encoding="utf-8",
        )

        launch = runner / "LaunchImage.imageset"
        launch.mkdir(parents=True, exist_ok=True)
        for suffix, scale in (("", 1), ("@2x", 2), ("@3x", 3)):
            self.crest_h(SPLASH_DP * scale).save(launch / f"LaunchImage{suffix}.png")

        watch = self.overlay / "ios" / "VesopaWatch" / "Assets.xcassets" / "AppIcon.appiconset"
        watch.mkdir(parents=True, exist_ok=True)
        # The Watch shows its icon in a circle on black and refuses alpha:
        # the crest on black, inside the circle.
        save_png(self.icon(1024, self.in_circle(1024 * 0.9), (0, 0, 0)).convert("RGB"), watch / "AppIcon-1024.png")
        return master

    def app_art(self):
        assets = self.overlay / "assets" / "venue"
        assets.mkdir(parents=True, exist_ok=True)
        # 3x of the 140dp it is drawn at, so it is sharp on any phone.
        self.crest_h(SPLASH_DP * 3).save(assets / "crest.png")
        # The Venue tab's header (lib/ui/venue_page.dart): 16:7, as the back
        # office's own header picture is shown.
        w, h = 1200, 525
        header = self.scene(w, h, crest_box=(w * 0.07, h * 0.5, h * 0.74))
        header.convert("RGB").save(assets / "header.webp", quality=82, method=6)
        save_png(self.empty_art(), assets / "empty.png")

    def empty_art(self):
        """For a page with nothing on it yet: posts and a ball on its way over.

        Transparent, in the club's bright red, so it reads on the light page
        and the dark one alike.
        """
        W, H = 960, 600
        ink = self.glow
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        ground = int(H * 0.86)
        d.rounded_rectangle((W * 0.12, ground, W * 0.88, ground + H * 0.022), radius=H * 0.011, fill=ink + (90,))
        img = Image.alpha_composite(img, self.posts((W, H), (W * 0.62, ground), H * 0.78, W * 0.3, H * 0.03, ink))
        img = Image.alpha_composite(
            img, self.flight((W, H), [(W * 0.16, ground - H * 0.02), (W * 0.30, H * 0.05), (W * 0.52, H * 0.27)], ink, 200, H * 0.012),
        )
        ball = self.ball(H * 0.26, ink, WHITE, 30)
        img.alpha_composite(ball, (int(W * 0.6 - ball.width / 2), int(H * 0.25 - ball.height / 2)))
        return img.resize((W // 2, H // 2), Image.LANCZOS)

    def store_art(self, master):
        self.store.mkdir(parents=True, exist_ok=True)
        save_png(master, self.store / "app-store-icon-1024.png")
        # Play takes a 32-bit PNG: the crest on nothing.
        save_png(self.icon(512, 512 * 0.88), self.store / "play-icon-512.png")

        w, h = 1024, 500
        crest_h = h * 0.74
        crest_x = 64
        g = self.scene(w, h, crest_box=(crest_x, h / 2, crest_h), posts_at=0.86, ball_at=(0.80, 0.17), text_room=True)
        d = ImageDraw.Draw(g)
        x = crest_x + round(self.crest.width * crest_h / self.crest.height) + 48
        title = ImageFont.truetype(str(FONT), 64)
        sub = ImageFont.truetype(str(FONT_MEDIUM), 30)
        name = self.venue["name"].upper()
        words = name.split(" ")
        lines = [" ".join(words[:-1]), words[-1]] if len(words) > 1 and d.textlength(name, font=title) > w - x - 50 else [name]
        y = h // 2 - (len(lines) * 74 + 60) // 2
        text = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        t = ImageDraw.Draw(text)
        for line in lines:
            t.text((x, y), line, font=title, fill=WHITE)
            y += 74
        t.rectangle((x, y + 12, x + 90, y + 18), fill=WHITE)
        t.text((x, y + 30), self.venue.get("tagline", ""), font=sub, fill=WHITE + (235,))
        g = Image.alpha_composite(g, self.shadow(text, 6, opacity=0.5, offset=(0, 3)))
        g = Image.alpha_composite(g, text)
        # Play wants no alpha on the feature graphic.
        save_png(g.convert("RGB"), self.store / "play-feature-graphic-1024x500.png")

    def web(self):
        """The members' web app's icons, and the club website's.

        Transparent wherever a browser keeps transparency (tab, install,
        Android home screen). The apple-touch-icon is on white: an iPhone
        fills its transparency with black.
        """
        def write(folder: Path, names):
            folder.mkdir(parents=True, exist_ok=True)
            save_png(self.icon(32, 32 * 0.97), folder / names["favicon"])
            save_png(self.icon(180, 180 * 0.80, WHITE).convert("RGB"), folder / "apple-touch-icon.png")
            save_png(self.icon(192, 192 * 0.94), folder / names["192"])
            save_png(self.icon(512, 512 * 0.94), folder / names["512"])
            # Maskable: the whole crest inside the middle 80% circle.
            save_png(self.icon(512, self.in_circle(512 * 0.8)), folder / "maskable-512.png")

        server = SERVER_ASSETS / self.venue["slug"]
        write(server, {"favicon": "favicon-32.png", "192": "icon-192.png", "512": "icon-512.png"})
        self.crest_h(256).save(server / "crest.png", optimize=True)
        site = self.dir / "website" / "public"
        if site.is_dir():
            write(site / "img", {"favicon": "favicon-32.png", "192": "icon-192.png", "512": "icon-512.png"})
            self.icon(48, 48 * 0.97).save(site / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
        return server


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: python vesopa_loyalty/tool/make_venue_art.py <venue folder>")
    art = Art(Path(sys.argv[1]).resolve())
    art.android()
    master = art.ios()
    art.app_art()
    art.store_art(master)
    web = art.web()
    print("written:", art.overlay, art.store, "and", web)


if __name__ == "__main__":
    main()
