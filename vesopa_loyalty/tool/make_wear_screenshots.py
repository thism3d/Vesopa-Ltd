"""
A venue app's Wear OS screenshots for Google Play.

    python vesopa_loyalty/tool/make_wear_screenshots.py LoughorRFC

Draws the four pages of the Wear OS app (android/wear, Screens.kt) as its
Compose layout puts them on a 456x456 round watch: the card with its QR, the
points, the membership and the news, against a made-up member. The accent is
the one make_venue_app.py gives the watch (venue.json colours: the glow, else
the club colour); the crest is the venue's own (brand/crest.png). Writes
<venue>/store/screenshots/wear-os/1-card.png ... 4-news.png, the size and
names Pontardawe RFC's Play listing uses; uploaded by hand in Play Console
(Store listing > Wear OS screenshots).

Needs Pillow and qrcode (pip install pillow qrcode).
"""

import json
import sys
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parents[1]  # vesopa_loyalty
REPO = HERE.parent
FONTS = REPO / "vesopa_server" / "public" / "assets" / "fonts" / "roboto"

SIZE = 456
DP = 2.0  # the scale Pontardawe RFC's Play screenshots were drawn at
WHITE = (255, 255, 255)
SECONDARY = (180, 180, 180)  # Screens.kt Secondary 0xFFB4B4B4
PANEL = (28, 28, 30)  # Screens.kt Panel 0xFF1C1C1E


def font(sp, bold=False):
    return ImageFont.truetype(str(FONTS / ("roboto-700.ttf" if bold else "roboto-400.ttf")), round(sp * DP))


def rgb(hex_colour):
    h = hex_colour.lstrip("#")
    return tuple(int(h[i: i + 2], 16) for i in (0, 2, 4))


def centred(d, y, text, f, fill):
    w = d.textlength(text, font=f)
    d.text(((SIZE - w) / 2, y), text, font=f, fill=fill)


def page(title, accent):
    im = Image.new("RGB", (SIZE, SIZE), (0, 0, 0))
    d = ImageDraw.Draw(im)
    centred(d, 8, "9:30", font(13), (220, 220, 220))
    if title:
        centred(d, 58, title, font(15), accent)
    return im, d


def card_page(v, crest, member, accent):
    im, d = page("", accent)
    # The crest and the club's name, side by side.
    name_f = font(13, bold=True)
    c = round(18 * DP)
    crest_im = crest.copy()
    crest_im.thumbnail((c, c))
    tw = d.textlength(v["name"], font=name_f)
    x = (SIZE - (c + 12 + tw)) / 2
    im.paste(crest_im, (round(x), 80 + (c - crest_im.height) // 2), crest_im)
    d.text((x + c + 12, 82), v["name"], font=name_f, fill=WHITE)
    # The QR on a white rounded panel.
    panel = 228
    px, py = (SIZE - panel) // 2, 123
    d.rounded_rectangle((px, py, px + panel, py + panel), radius=26, fill=WHITE)
    qr = qrcode.QRCode(border=0, box_size=10)
    qr.add_data(member["card_number"])
    qr.make()
    q = qr.make_image(fill_color="black", back_color="white").convert("RGB").resize((panel - 34, panel - 34), Image.NEAREST)
    im.paste(q, (px + 17, py + 17))
    n = member["card_number"]
    step = 3 if len(n) % 4 else 4
    num = " ".join(n[i: i + step] for i in range(0, len(n), step))
    centred(d, 360, num, font(14, bold=True), WHITE)
    centred(d, 400, "Show this at the till", font(11), SECONDARY)
    return im


def points_page(member, accent, on_accent):
    im, d = page("Points", accent)
    centred(d, 112, str(member["points"]), font(52, bold=True), WHITE)
    centred(d, 228, "points", font(15), SECONDARY)
    centred(d, 274, member["worth"], font(16, bold=True), WHITE)
    tier_f = font(12, bold=True)
    tw = d.textlength(member["tier"], font=tier_f)
    bx, by = (SIZE - tw) / 2 - 20, 326
    d.rounded_rectangle((bx, by, bx + tw + 40, by + 48), radius=24, fill=accent)
    d.text((bx + 20, by + 9), member["tier"], font=tier_f, fill=on_accent)
    note_f = font(12, bold=True)
    note = "Enough to spend"
    w = 22 + 10 + d.textlength(note, font=note_f)
    x = (SIZE - w) / 2
    # The tick drawn, as Roboto here has no ✓.
    d.line([(x, 408), (x + 7, 416), (x + 20, 397)], fill=accent, width=4, joint="curve")
    d.text((x + 32, 394), note, font=note_f, fill=WHITE)
    return im


def membership_page(member, accent):
    im, d = page("Membership", accent)
    y = 109
    for label, value in member["rows"]:
        d.rounded_rectangle((73, y, 383, y + 64), radius=24, fill=PANEL)
        d.text((93, y + 18), label, font=font(13), fill=SECONDARY)
        vf = font(13, bold=True)
        d.text((363 - d.textlength(value, font=vf), y + 18), value, font=vf, fill=WHITE)
        y += 74
    return im


def wrap(d, text, f, width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if d.textlength(trial, font=f) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line]


def news_page(member, accent):
    im, d = page("News", accent)
    y = 109
    tf, df = font(13, bold=True), font(12)
    for title, date, unread in member["news"]:
        lines = wrap(d, title, tf, 270 - (22 if unread else 0))[:3]
        h = 24 + len(lines) * 36 + 40
        d.rounded_rectangle((71, y, 385, y + h), radius=28, fill=PANEL)
        tx = 91
        if unread:
            d.ellipse((tx, y + 27, tx + 12, y + 39), fill=accent)
            tx += 22
        for i, line in enumerate(lines):
            d.text((tx, y + 16 + i * 36), line, font=tf, fill=WHITE)
        d.text((91, y + 18 + len(lines) * 36), date, font=df, fill=SECONDARY)
        y += h + 12
    return im


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    venue_dir = Path(sys.argv[1]).resolve()
    v = json.loads((venue_dir / "venue.json").read_text(encoding="utf-8"))
    c = v["colours"]
    accent = rgb(c.get("glow") or c["background"])
    on_accent = rgb(c.get("text", "#FFFFFF"))
    crest = Image.open(venue_dir / "brand" / "crest.png").convert("RGBA")
    # The same kind of made-up member as the phone's screenshots.
    member = {
        "card_number": "999800147",
        "points": 1240,
        "worth": "worth £12.40",
        "tier": "Full member",
        "rows": [("Visits", "37"), ("Last visit", "11 Oct"), ("Until", "31 Jul 2027"), ("Spend from", "500 pts")],
        "news": [("Home game on Saturday, kick-off 2.30pm", "10 Oct", True),
                 ("Quiz night in the clubhouse on Thursday", "8 Oct", False)],
    }
    out = venue_dir / "store" / "screenshots" / "wear-os"
    out.mkdir(parents=True, exist_ok=True)
    shots = {
        "1-card": card_page(v, crest, member, accent),
        "2-points": points_page(member, accent, on_accent),
        "3-membership": membership_page(member, accent),
        "4-news": news_page(member, accent),
    }
    for name, im in shots.items():
        im.save(out / f"{name}.png", optimize=True)
    print(f"wear-os: {len(shots)} screenshots ({SIZE}x{SIZE}) in {out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
