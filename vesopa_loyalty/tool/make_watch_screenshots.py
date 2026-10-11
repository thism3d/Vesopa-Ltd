"""
A venue app's Apple Watch screenshots for the App Store.

    python vesopa_loyalty/tool/make_watch_screenshots.py PontardaweRFC

The watch app (ios/VesopaWatch) is drawn here screen by screen, as its
SwiftUI lays it out, against the same made-up member the phone's screenshots
use (screenshots/store_screenshots_test.dart). The words and figures come
from what lib/data/watch_card.dart would send it. A watch build cannot be run
anywhere but a Mac's simulator.

Writes <venue>/store/screenshots/watch-ultra/ (410x502, Apple Watch Ultra) and
watch-series-10/ (416x496, Series 10/11, 46mm). tool/app_store_connect.py
`store` uploads them with the phone's and iPad's.

Needs Pillow and qrcode (pip install pillow qrcode).
"""

import json
import sys
from datetime import date, timedelta
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parents[1]  # vesopa_loyalty
REPO = HERE.parent
FONTS = REPO / "vesopa_server" / "public" / "assets" / "fonts" / "inter"

SIZES = {"watch-ultra": (410, 502), "watch-series-10": (416, 496)}

WHITE = (255, 255, 255)
SECONDARY = (155, 155, 160)
PANEL = (28, 28, 28)
LABEL = (181, 181, 181)


def font(size, bold=False):
    return ImageFont.truetype(str(FONTS / ("inter-700.ttf" if bold else "inter-400.ttf")), size)


def rgb(hex_colour):
    h = hex_colour.lstrip("#")
    return tuple(int(h[i: i + 2], 16) for i in (0, 2, 4))


def watch_title(name):
    """lib/data/watch_card.dart watchTitle."""
    n = name.strip()
    if n.lower().startswith("the "):
        n = n[4:].strip()
    if len(n) <= 10:
        return n
    best = None
    for word in n.split():
        if len(word) <= 12 and (best is None or len(word) >= len(best)):
            best = word
    return best or n


def day_month(d):
    return f"{d.day} {d.strftime('%b')}"


def the_member(venue):
    """The phone screenshots' member, as watch_card.dart formats it."""
    today = date.today()
    expiry = date(today.year + 1, 6, 30)
    return {
        "title": watch_title(venue["name"]),
        "qr": "999800147",
        "number": "0014 7",  # watch_card.dart groups it in fours
        "points": 342,
        "worth": "worth £3.42",
        "spend_note": "158 more to spend",
        "rows": [
            ("Visits", "38"),
            ("Last visit", day_month(today - timedelta(days=2))),
            ("Until", f"{expiry.day} {expiry.strftime('%b')} {expiry.year}"),
            ("Spend from", "500 pts"),
        ],
        "news": [
            ("Home game on Saturday", day_month(today), True),
            ("International on the big screen", day_month(today - timedelta(days=1)), True),
            ("Quiz night, Thursday 8pm", day_month(today - timedelta(days=4)), False),
        ],
    }


class Screen:
    """One watch screen: black, the title top left in the accent, the time
    top right, as watchOS draws a NavigationStack."""

    def __init__(self, size, accent, title):
        self.w, self.h = size
        self.s = self.w / 205  # points to pixels (a 410px Ultra is 205pt wide)
        self.im = Image.new("RGB", size, (0, 0, 0))
        self.d = ImageDraw.Draw(self.im)
        self.accent = accent
        pad = 12 * self.s
        self.d.text((pad, 14 * self.s), title, font=font(round(15 * self.s), bold=True), fill=accent)
        self.d.text((self.w - pad, 14 * self.s), "10:09", font=font(round(15 * self.s), bold=True), fill=WHITE, anchor="ra")
        self.y = 44 * self.s

    def pt(self, v):
        return round(v * self.s)

    def centre(self, text, size, colour=WHITE, bold=False, gap=4):
        f = font(self.pt(size), bold)
        self.d.text((self.w / 2, self.y), text, font=f, fill=colour, anchor="ma")
        box = self.d.textbbox((0, 0), text, font=f)
        self.y += box[3] + self.pt(gap)

    def panel(self, draw_inside, height):
        x0, x1 = self.pt(8), self.w - self.pt(8)
        self.d.rounded_rectangle((x0, self.y, x1, self.y + self.pt(height)), radius=self.pt(12), fill=PANEL)
        draw_inside(x0 + self.pt(10), self.y + self.pt(9), x1 - self.pt(10))
        self.y += self.pt(height) + self.pt(5)


def card(size, accent, m):
    sc = Screen(size, accent, m["title"])
    side = sc.pt(118)
    qr = qrcode.QRCode(border=0, box_size=10, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(m["qr"])
    code = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    inner = side - sc.pt(14)
    code = code.resize((inner, inner), Image.NEAREST)
    x = (sc.w - side) // 2
    sc.d.rounded_rectangle((x, sc.y, x + side, sc.y + side), radius=sc.pt(17), fill=WHITE)
    sc.im.paste(code, (x + sc.pt(7), int(sc.y) + sc.pt(7)))
    sc.y += side + sc.pt(7)
    sc.centre(m["number"], 19, bold=True, gap=3)
    sc.centre("Show this at the till", 12, SECONDARY)
    return sc.im


def points(size, accent, m):
    sc = Screen(size, accent, "Points")
    sc.y += sc.pt(6)
    sc.centre(str(m["points"]), 54, bold=True, gap=2)
    sc.centre("points", 16, SECONDARY, gap=6)
    sc.centre(m["worth"], 17, bold=True, gap=10)
    sc.centre(m["spend_note"], 13, SECONDARY)
    return sc.im


def membership(size, accent, m):
    sc = Screen(size, accent, "Membership")
    for label, value in m["rows"]:
        def inside(x0, y0, x1, label=label, value=value):
            f, fb = font(sc.pt(15)), font(sc.pt(15), bold=True)
            sc.d.text((x0, y0), label, font=f, fill=LABEL)
            sc.d.text((x1, y0), value, font=fb, fill=WHITE, anchor="ra")
        sc.panel(inside, 38)
    return sc.im


def news(size, accent, m):
    sc = Screen(size, accent, "News")
    for title, when, unread in m["news"]:
        f = font(sc.pt(15), bold=True)
        # Wrap to the panel, at most three lines (lineLimit(3)).
        words, lines, line = title.split(), [], ""
        width = sc.w - sc.pt(16) - sc.pt(20) - (sc.pt(11) if unread else 0)
        for word in words:
            trial = f"{line} {word}".strip()
            if sc.d.textlength(trial, font=f) <= width:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
        lines = lines[:3]
        line_h = sc.pt(19)
        height = 18 + (len(lines) * line_h) / sc.s + 16

        def inside(x0, y0, x1, lines=lines, when=when, unread=unread):
            tx = x0 + (sc.pt(11) if unread else 0)
            if unread:
                r = sc.pt(3)
                cy = y0 + sc.pt(9)
                sc.d.ellipse((x0, cy - r, x0 + 2 * r, cy + r), fill=sc.accent)
            for i, text in enumerate(lines):
                sc.d.text((tx, y0 + i * line_h), text, font=f, fill=WHITE)
            sc.d.text((x0, y0 + len(lines) * line_h + sc.pt(2)), when, font=font(sc.pt(12)), fill=SECONDARY)
        sc.panel(inside, height)
    return sc.im


SCREENS = [("1-card", card), ("2-points", points), ("3-membership", membership), ("4-news", news)]


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    venue_dir = Path(sys.argv[1]).resolve()
    venue = json.loads((venue_dir / "venue.json").read_text(encoding="utf-8"))
    colours = venue.get("colours", {})
    # The watch's tint is the venue's bright colour: it has to read on black.
    accent = rgb(colours.get("glow") or colours.get("background") or "#C41414")
    m = the_member(venue)
    for folder, size in SIZES.items():
        out = venue_dir / "store" / "screenshots" / folder
        out.mkdir(parents=True, exist_ok=True)
        for old in out.glob("*.png"):
            old.unlink()
        for name, draw in SCREENS:
            draw(size, accent, m).save(out / f"{name}.png")
        print(f"{folder}: {len(SCREENS)} screenshots in {out}")


if __name__ == "__main__":
    main()
