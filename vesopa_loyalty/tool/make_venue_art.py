"""
Every picture a venue's own phone app needs, drawn from the venue's crest.

    python vesopa_loyalty/tool/make_venue_art.py PontardaweRFC

Reads <venue>/venue.json and <venue>/brand/crest.png (a transparent PNG, the
logo the venue uploaded to Loyalty App in the back office) and writes:

  <venue>/overlay/...   files laid over a copy of vesopa_loyalty by
                        tool/make_venue_app.py: launcher icons, the Android
                        12+ and older splash screens, the notification icon,
                        the iOS AppIcon set, launch image and Watch icon, and
                        the crest the animated intro opens with
  <venue>/store/        Play icon (512), Play feature graphic (1024x500) and
                        the App Store icon (1024, no alpha)

Run it here, in the cloud, where Pillow is; the output is committed, so the
machine that builds the app needs nothing but Python's standard library.

THE CREST IS THE SAME SIZE AT EVERY STEP OF THE OPENING: 140dp tall on the
Android 12+ splash, on the older splash, on the iPhone launch screen and as
the first frame of the Flutter intro (lib/ui/venue_intro.dart). Change one and
the hand-over between the native splash and Flutter visibly jumps.
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
FONT = ROOT / "vesopa_express" / "assets" / "fonts" / "Montserrat-ExtraBold.ttf"
FONT_MEDIUM = ROOT / "vesopa_express" / "assets" / "fonts" / "Montserrat-Medium.ttf"

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
SPLASH_DP = 140  # the crest's height on every splash; see the docstring


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


class Art:
    def __init__(self, venue_dir: Path):
        self.dir = venue_dir
        self.venue = json.loads((venue_dir / "venue.json").read_text(encoding="utf-8"))
        c = self.venue["colours"]
        self.bg = hex_rgb(c["background"])
        self.deep = hex_rgb(c["deep"])
        self.glow = hex_rgb(c["glow"])
        crest = Image.open(venue_dir / "brand" / "crest.png").convert("RGBA")
        self.crest = crest.crop(crest.split()[3].getbbox())
        self.overlay = venue_dir / "overlay"
        self.store = venue_dir / "store"

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

    def on_canvas(self, size, crest_height, *, field=True, shadow=True, y_bias=0.0):
        """The crest centred on a square: on the club red, or on nothing."""
        canvas = self.field(size) if field else Image.new("RGBA", (size, size), (0, 0, 0, 0))
        crest = self.crest_h(crest_height)
        layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        x = (size - crest.width) // 2
        y = (size - crest.height) // 2 + round(size * y_bias)
        layer.paste(crest, (x, y), crest)
        if shadow:
            canvas = Image.alpha_composite(canvas, self.shadow(layer, max(1, size // 40), offset=(0, max(1, size // 60))))
        return Image.alpha_composite(canvas, layer)

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

    @staticmethod
    def rounded(img, frac=0.2):
        s = img.width * 4
        mask = Image.new("L", (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * frac), fill=255)
        mask = mask.resize(img.size, Image.LANCZOS)
        out = Image.new("RGBA", img.size, (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        return out

    # ---- outputs ---------------------------------------------------------

    def android(self):
        res = self.overlay / "android" / "app" / "src" / "main" / "res"
        for name, scale in DENSITIES.items():
            mip = res / f"mipmap-{name}"
            mip.mkdir(parents=True, exist_ok=True)
            px = round(48 * scale)
            # Android 7: the tile as it is.
            self.rounded(self.on_canvas(px, px * 0.78)).save(mip / "ic_launcher.png")
            self.on_canvas(px, px * 0.78).save(mip / "ic_launcher_round.png")
            # Android 8+: a 108dp canvas of which a 72dp circle or squircle
            # shows. The shield's corners stay inside a 66dp circle at about 58dp tall.
            big = round(108 * scale)
            self.field(big).save(mip / "ic_launcher_background.png")
            self.on_canvas(big, big * 0.54, field=False).save(mip / "ic_launcher_foreground.png")
            # Android 13 themed icons: the launcher tints this outline.
            self.silhouette(big, 0.54).save(mip / "ic_launcher_monochrome.png")

            draw = res / f"drawable-{name}"
            draw.mkdir(parents=True, exist_ok=True)
            # The status-bar icon: Android keeps the shape and paints it white.
            self.silhouette(round(24 * scale), 0.92).save(draw / "ic_notification.png")

        v26 = res / "mipmap-anydpi-v26"
        v26.mkdir(parents=True, exist_ok=True)
        adaptive = (
            '<?xml version="1.0" encoding="utf-8"?>\n'
            "<!-- Written by vesopa_loyalty/tool/make_venue_art.py. -->\n"
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@mipmap/ic_launcher_background"/>\n'
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
        runner = self.overlay / "ios" / "Runner" / "Assets.xcassets"
        icons = runner / "AppIcon.appiconset"
        icons.mkdir(parents=True, exist_ok=True)
        sizes = {
            "Icon-App-20x20@1x.png": 20, "Icon-App-20x20@2x.png": 40, "Icon-App-20x20@3x.png": 60,
            "Icon-App-29x29@1x.png": 29, "Icon-App-29x29@2x.png": 58, "Icon-App-29x29@3x.png": 87,
            "Icon-App-40x40@1x.png": 40, "Icon-App-40x40@2x.png": 80, "Icon-App-40x40@3x.png": 120,
            "Icon-App-60x60@2x.png": 120, "Icon-App-60x60@3x.png": 180,
            "Icon-App-76x76@1x.png": 76, "Icon-App-76x76@2x.png": 152,
            "Icon-App-83.5x83.5@2x.png": 167, "Icon-App-1024x1024@1x.png": 1024,
        }
        master = self.on_canvas(1024, 1024 * 0.8).convert("RGB")
        for filename, px in sizes.items():
            # iOS masks the corners itself and refuses an icon with alpha.
            (master if px == 1024 else master.resize((px, px), Image.LANCZOS)).save(icons / filename)

        launch = runner / "LaunchImage.imageset"
        launch.mkdir(parents=True, exist_ok=True)
        for suffix, scale in (("", 1), ("@2x", 2), ("@3x", 3)):
            self.crest_h(SPLASH_DP * scale).save(launch / f"LaunchImage{suffix}.png")

        watch = self.overlay / "ios" / "VesopaWatch" / "Assets.xcassets" / "AppIcon.appiconset"
        watch.mkdir(parents=True, exist_ok=True)
        # The Watch shows its icon in a circle: the crest a little smaller.
        self.on_canvas(1024, 1024 * 0.7).convert("RGB").save(watch / "AppIcon-1024.png")
        return master

    def intro(self):
        assets = self.overlay / "assets" / "venue"
        assets.mkdir(parents=True, exist_ok=True)
        # 3x of the 140dp it is drawn at, so it is sharp on any phone.
        self.crest_h(SPLASH_DP * 3).save(assets / "crest.png")

    def store_art(self, master):
        self.store.mkdir(parents=True, exist_ok=True)
        master.save(self.store / "app-store-icon-1024.png")
        self.on_canvas(512, 512 * 0.8).save(self.store / "play-icon-512.png")

        w, h = 1024, 500
        g = self.field(w, h)
        crest = self.crest_h(h * 0.78)
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        layer.paste(crest, (70, (h - crest.height) // 2), crest)
        g = Image.alpha_composite(g, self.shadow(layer, 14, offset=(0, 8)))
        g = Image.alpha_composite(g, layer)
        d = ImageDraw.Draw(g)
        x = 70 + crest.width + 56
        title = ImageFont.truetype(str(FONT), 64)
        sub = ImageFont.truetype(str(FONT_MEDIUM), 30)
        name = self.venue["name"].upper()
        words = name.split(" ")
        lines = [" ".join(words[:-1]), words[-1]] if len(words) > 1 and d.textlength(name, font=title) > w - x - 50 else [name]
        y = h // 2 - (len(lines) * 74 + 60) // 2
        for line in lines:
            d.text((x, y), line, font=title, fill=(255, 255, 255))
            y += 74
        d.rectangle((x, y + 12, x + 90, y + 18), fill=(255, 255, 255))
        d.text((x, y + 30), self.venue.get("tagline", ""), font=sub, fill=(255, 255, 255, 220))
        g.convert("RGB").save(self.store / "play-feature-graphic-1024x500.png")


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: python vesopa_loyalty/tool/make_venue_art.py <venue folder>")
    art = Art(Path(sys.argv[1]).resolve())
    art.android()
    master = art.ios()
    art.intro()
    art.store_art(master)
    print("written:", art.overlay, "and", art.store)


if __name__ == "__main__":
    main()
