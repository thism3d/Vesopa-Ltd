"""
A venue app's App Store screenshots, from the app itself.

    python vesopa_loyalty/tool/make_store_screenshots.py PontardaweRFC

1. makes the venue's project (make_venue_app.py),
2. runs screenshots/store_screenshots_test.dart in it, which draws the real
   pages against a made-up member at the App Store's sizes,
3. frames each one: the venue colour behind, its caption above, the screen
   below with rounded corners,

and writes them to <venue>/store/screenshots/iphone-6.9/ (1320x2868),
iphone-duo/ (2007x2853, iPhone Duo opened out) and ipad-13/ (2048x2732),
where tool/app_store_connect.py `store` uploads them
from, and to android-phone/ (1080x1920), android-tablet-7/ (1200x1920) and
android-tablet-10/ (1600x2560) for Google Play, uploaded by hand. Captions and their order are "screenshots" in <venue>/store/app_store.json.

4. draws the App Store's creative assets (iOS 27, October 2026) from the
   crest and the card: <venue>/store/creative/header.png (the product page
   header, 21:9, 3840x1646) and search.png (search results, 3:2, 3840x2560),
   no transparency, as App Store Connect's creative assets specification asks.

Needs Flutter on the PATH and Pillow.
"""

import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parents[1]  # vesopa_loyalty
REPO = HERE.parent

LIVE = "https://loyalty.vesopa.com"
# App Store sizes, then Google Play's: a phone and 7- and 10-inch tablets, each
# no longer than twice its width, as Play requires.
SIZES = {
    "iphone-6.9": (1320, 2868), "iphone-duo": (2007, 2853), "ipad-13": (2048, 2732),
    "android-phone": (1080, 1920), "android-tablet-7": (1200, 1920), "android-tablet-10": (1600, 2560),
}
FONT_BOLD = REPO / "vesopa_server" / "public" / "assets" / "fonts" / "oswald" / "oswald-700.ttf"
FONT_TEXT = REPO / "vesopa_server" / "public" / "assets" / "fonts" / "inter" / "inter-400.ttf"


def rgb(hex_colour):
    h = hex_colour.lstrip("#")
    return tuple(int(h[i: i + 2], 16) for i in (0, 2, 4))


def gradient(size, top, bottom):
    w, h = size
    col = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        col.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return col.resize((w, h))


def wrap(draw, text, font, width):
    words, lines, line = text.split(), [], ""
    for word in words:
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def frame(raw: Path, out: Path, size, colours, title, subtitle):
    w, h = size
    bg = gradient(size, rgb(colours["background"]), rgb(colours["deep"]))
    draw = ImageDraw.Draw(bg)
    tablet = w / h > 0.6
    title_font = ImageFont.truetype(str(FONT_BOLD), int(w * (0.062 if tablet else 0.088)))
    sub_font = ImageFont.truetype(str(FONT_TEXT), int(w * (0.026 if tablet else 0.04)))

    y = int(h * 0.045)
    for line in wrap(draw, title.upper(), title_font, w * 0.86):
        tw = draw.textlength(line, font=title_font)
        draw.text(((w - tw) / 2, y), line, font=title_font, fill=(255, 255, 255))
        y += int(title_font.size * 1.15)
    y += int(sub_font.size * 0.4)
    for line in wrap(draw, subtitle, sub_font, w * 0.82):
        tw = draw.textlength(line, font=sub_font)
        draw.text(((w - tw) / 2, y), line, font=sub_font, fill=(255, 235, 235))
        y += int(sub_font.size * 1.35)
    y += int(h * 0.025)

    # The screen, as large as the space under the words allows.
    shot = Image.open(raw).convert("RGB")
    avail_h = h - y + int(h * 0.02)
    scale = min(w * (0.80 if tablet else 0.84) / shot.width, avail_h / shot.height)
    sw, sh = int(shot.width * scale), int(shot.height * scale)
    shot = shot.resize((sw, sh), Image.LANCZOS)
    radius = int(sw * (0.035 if tablet else 0.09))
    mask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw - 1, sh - 1), radius=radius, fill=255)
    x = (w - sw) // 2

    shadow = Image.new("L", (w, h), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((x, y + 18, x + sw, y + sh + 18), radius=radius, fill=150)
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    bg.paste(Image.new("RGB", size, (20, 0, 0)), (0, 0), shadow)
    # A thin dark bezel round the screen.
    bezel = max(6, sw // 90)
    ImageDraw.Draw(bg).rounded_rectangle(
        (x - bezel, y - bezel, x + sw + bezel, y + sh + bezel), radius=radius + bezel, fill=(18, 12, 12))
    bg.paste(shot, (x, y), mask)
    out.parent.mkdir(parents=True, exist_ok=True)
    bg.save(out, optimize=True)


def phone(raw: Path, height):
    """A screen as a phone: rounded, in a thin dark bezel, on a soft shadow.
    Answers (image, mask) for pasting."""
    shot = Image.open(raw).convert("RGB")
    scale = height / shot.height
    sw, sh = int(shot.width * scale), height
    shot = shot.resize((sw, sh), Image.LANCZOS)
    radius, bezel = int(sw * 0.1), max(10, sw // 40)
    w, h = sw + 2 * bezel, sh + 2 * bezel
    body = Image.new("RGB", (w, h), (18, 12, 12))
    screen_mask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(screen_mask).rounded_rectangle((0, 0, sw - 1, sh - 1), radius=radius, fill=255)
    body.paste(shot, (bezel, bezel), screen_mask)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=radius + bezel, fill=255)
    return body, mask


def paste_with_shadow(bg, img, mask, xy, blur=40, drop=28):
    x, y = xy
    shadow = Image.new("L", bg.size, 0)
    shadow.paste(mask.point(lambda a: int(a * 0.6)), (x, y + drop))
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    bg.paste(Image.new("RGB", bg.size, (15, 0, 0)), (0, 0), shadow)
    bg.paste(img, (x, y), mask)


def creative(venue_dir: Path, raw: Path, v, store):
    """The product page header and the search results picture.

    Apple lays the app's name and icon over the header and crops it to fit
    each device, so the crest and the card sit in the middle and no words are
    drawn on it. The search picture is seen small next to the app's name, so
    it has the club's name and one line, large."""
    colours = v["colours"]
    crest_path = venue_dir / "brand" / "crest.png"
    out_dir = venue_dir / "store" / "creative"
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True)
    card = raw / "iphone-6.9-1-card.png"
    news = raw / "iphone-6.9-3-news.png"

    def background(size):
        w, h = size
        bg = gradient(size, rgb(colours["glow"] if "glow" in colours else colours["background"]), rgb(colours["deep"]))
        # A soft light behind the middle, where the eye goes.
        glow = Image.new("L", size, 0)
        ImageDraw.Draw(glow).ellipse((w * 0.2, -h * 0.3, w * 0.8, h * 0.9), fill=110)
        glow = glow.filter(ImageFilter.GaussianBlur(h // 5))
        bg.paste(Image.new("RGB", size, rgb(colours["background"])), (0, 0), glow)
        return bg

    def crest(height):
        c = Image.open(crest_path).convert("RGBA")
        return c.resize((int(c.width * height / c.height), height), Image.LANCZOS)

    # Header, 21:9.
    size = (3840, 1646)
    bg = background(size)
    c = crest(int(size[1] * 0.62))
    cx = int(size[0] * 0.40) - c.width // 2
    cy = (size[1] - c.height) // 2
    halo = Image.new("L", size, 0)
    halo.paste(c.getchannel("A"), (cx, cy + 30))
    halo = halo.filter(ImageFilter.GaussianBlur(36))
    bg.paste(Image.new("RGB", size, (25, 0, 0)), (0, 0), halo.point(lambda a: int(a * 0.55)))
    bg.paste(c, (cx, cy), c)
    for path, scale, dx in ((news, 0.70, 0.66), (card, 0.84, 0.58)):
        body, mask = phone(path, int(size[1] * scale))
        paste_with_shadow(bg, body, mask, (int(size[0] * dx) - body.width // 2 + (0 if path == card else 120), (size[1] - body.height) // 2 + (0 if path == card else 40)))
    bg.save(out_dir / "header.png", optimize=True)

    # Search results, 3:2.
    size = (3840, 2560)
    bg = background(size)
    draw = ImageDraw.Draw(bg)
    c = crest(int(size[1] * 0.36))
    left = int(size[0] * 0.08)
    bg.paste(c, (left, int(size[1] * 0.14)), c)
    title_font = ImageFont.truetype(str(FONT_BOLD), int(size[1] * 0.105))
    sub_font = ImageFont.truetype(str(FONT_TEXT), int(size[1] * 0.045))
    y = int(size[1] * 0.56)
    for line in wrap(draw, v["name"].upper(), title_font, size[0] * 0.46):
        draw.text((left, y), line, font=title_font, fill=(255, 255, 255))
        y += int(title_font.size * 1.1)
    y += int(sub_font.size * 0.5)
    for line in wrap(draw, store.get("subtitle", v.get("tagline", "")), sub_font, size[0] * 0.44):
        draw.text((left, y), line, font=sub_font, fill=(255, 232, 232))
        y += int(sub_font.size * 1.35)
    body, mask = phone(card, int(size[1] * 0.86))
    paste_with_shadow(bg, body, mask, (int(size[0] * 0.75) - body.width // 2, (size[1] - body.height) // 2))
    bg.save(out_dir / "search.png", optimize=True)
    print(f"creative assets: header.png (3840x1646) and search.png (3840x2560) in {out_dir.relative_to(REPO)}")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python vesopa_loyalty/tool/make_store_screenshots.py <venue folder>")
    venue_dir = Path(sys.argv[1]).resolve()
    v = json.loads((venue_dir / "venue.json").read_text(encoding="utf-8"))
    store = json.loads((venue_dir / "store" / "app_store.json").read_text(encoding="utf-8"))
    shots = store["screenshots"]

    subprocess.run([sys.executable, str(HERE / "tool" / "make_venue_app.py"), str(venue_dir)], check=True)
    app = venue_dir / "build" / "app"
    (app / "screenshots").mkdir(exist_ok=True)
    shutil.copy2(HERE / "screenshots" / "store_screenshots_test.dart", app / "screenshots")
    shutil.copy2(venue_dir / "venue.json", app / "screenshots" / "venue.json")
    # The venue's look as members see it today, from the back office.
    try:
        with urllib.request.urlopen(f"{LIVE}/loyalty/v1/app/{v['slug']}", timeout=20) as res:
            (app / "screenshots" / "brand.json").write_bytes(res.read())
        print(f"  branding from {LIVE}")
    except OSError as e:
        print(f"! could not fetch the live branding ({e}); using venue.json's colours")
    raw = app / "build" / "screenshots" / "raw"
    shutil.rmtree(raw, ignore_errors=True)

    flutter = shutil.which("flutter") or shutil.which("flutter.bat")
    if not flutter:
        raise SystemExit("Flutter is not on the PATH.")
    env = dict(os.environ, SCREENSHOT_OUT=str(raw))
    env.setdefault("FLUTTER_ROOT", str(Path(flutter).resolve().parents[1]))
    subprocess.run([flutter, "pub", "get"], cwd=app, check=True, env=env)
    subprocess.run([flutter, "test", "screenshots/store_screenshots_test.dart",
                    "--dart-define-from-file=venue_defines.json"], cwd=app, check=True, env=env)

    for device, size in SIZES.items():
        out_dir = venue_dir / "store" / "screenshots" / device
        shutil.rmtree(out_dir, ignore_errors=True)
        for n, s in enumerate(shots, 1):
            src = raw / f"{device}-{s['screen']}.png"
            if not src.exists():
                raise SystemExit(f"{src.name} was not drawn: is '{s['screen']}' in store_screenshots_test.dart?")
            frame(src, out_dir / f"{n}-{s['screen'].split('-', 1)[-1]}.png", size, v["colours"], s["title"], s["subtitle"])
        print(f"{device}: {len(shots)} screenshots in {out_dir.relative_to(REPO)}")
    creative(venue_dir, raw, v, store)


if __name__ == "__main__":
    main()
