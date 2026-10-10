"""
A venue app's App Store screenshots, from the app itself.

    python vesopa_loyalty/tool/make_store_screenshots.py PontardaweRFC

1. makes the venue's project (make_venue_app.py),
2. runs screenshots/store_screenshots_test.dart in it, which draws the real
   pages against a made-up member at the App Store's sizes,
3. frames each one: the venue colour behind, its caption above, the screen
   below with rounded corners,

and writes them to <venue>/store/screenshots/iphone-6.9/ (1290x2796) and
ipad-13/ (2048x2732), where tool/app_store_connect.py `store` uploads them
from. Captions and their order are "screenshots" in <venue>/store/app_store.json.

Needs Flutter on the PATH and Pillow.
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parents[1]  # vesopa_loyalty
REPO = HERE.parent

SIZES = {"iphone-6.9": (1290, 2796), "ipad-13": (2048, 2732)}
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


if __name__ == "__main__":
    main()
