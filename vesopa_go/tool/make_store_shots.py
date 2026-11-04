"""Vesopa Go store screenshots (2026-11-04): headline + real screen in a device.

    python tool/make_store_shots.py android
    python tool/make_store_shots.py ipad      # 13-inch iPad, landscape, 2732x2048

Real app screens from store/screenshots/<device>/ go into a phone frame under a
headline, on the Vesopa brand ground (black, lime light), headline in
Montserrat with one word in lime, the "vesopa GO" lockup at the foot. Laid out
in HTML and rendered by headless Edge (tool/make_epos_logo.py's renderer).
Output: store/marketing/<device>/NN-name.png
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
GO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import make_epos_logo as R  # noqa: E402  headless-Edge renderer
import make_vesopa_app_logos as L  # noqa: E402  the brand lockup

FONTS = ROOT / "brand_assets" / "Fonts" / "Montserrat"
LIME = "#A5C715"

# (screen file, headline with the lime word in *stars*, small line under it)
SHOTS = [
    ("01-sale", "Orders *anywhere* on the floor", "Your till, in your pocket"),
    ("02-pay", "Every way to *pay*", "Cash, card, Tap to Pay, gift cards and more"),
    ("03-qr-pay", "*QR Pay* at the table", "Guests scan, pay and go"),
    ("04-check", "The whole bill at a *glance*", "Every item, every server, live"),
    ("05-approved", "Paid. *Done.*", "Print or email the receipt in one tap"),
]

DEVICES = {
    "android": dict(W=1080, H=1920, src="android-phone", frame_w=740, radius=92, bezel=24),
    # App Store 13-inch iPad, landscape; the headline and lockup scaled up to match
    "ipad": dict(W=2732, H=2048, src="ipad-13", radius=70, bezel=34, tablet=True, k=1.45, head=400, foot=200),
}


# Screens that show a staff member's initials: (device, shot) -> avatar circle
# centre x, y and radius in the screenshot's pixels. A brand badge covers it.
AVATARS = {("android-phone", "01-sale"): [(998.5, 83.5, 46, "circle"), (213, 82, 45, "box")],
           ("ipad-13", "01-sale"): [(2532.5, 56, 30, "circle"), (143.5, 55.5, 31.5, "box")]}


# Product photos laid onto the screenshot's own tiles, as the app draws a tile
# with a photo: the picture fills the tile, name and price over a dark shade
# at the foot. Photos are The Vesopa Kitchen's own (its back office uploads).
# (device, shot) -> [(tile box x0, y0, x1, y1), photo, ground, name, price]
PHOTO_BASE = "https://go.vesopaepos.com/uploads/"
PHOTOS = {("android-phone", "01-sale"): [
    ((376, 480, 703, 761), "f9046f88-adb8-43f2-99c7-d03505dfe7eb.png", "#FFFFFF", "Carling ½", "£6.05"),
    ((728, 480, 1055, 761), "048d0e79-413f-477a-9ecd-07b24b302489.png", "#0B0B0B", "Guinness", "£3.00"),
    ((376, 786, 703, 1068), "e04f4376-1bd5-46f7-8503-e07d59277091.png", "#FFFFFF", "Peroni", "£5.00"),
    ((376, 1092, 703, 1374), "40bf993b-bb19-442b-ba0f-d2560964607a.png", "#FFFFFF", "Diet Coke", "£2.50"),
    # pictures the owner supplied (store/marketing/photos); "cover" fills the tile
    ((24, 1092, 351, 1374), "coca-cola.png", "#FFFFFF", "Coca-Cola", "£2.50"),
    ((728, 1092, 1055, 1374), "lemonade.jpg", "cover", "Lemonade", "£2.30"),
    ((728, 786, 1055, 1068), "food.jpg", "cover", "FOOD", "›››"),
], ("ipad-13", "01-sale"): [  # the same products on the iPad's 6-wide grid, text at 0.8 of the phone's
    ((1115, 320, 1422, 620), "f9046f88-adb8-43f2-99c7-d03505dfe7eb.png", "#FFFFFF", "Carling ½", "£6.05", .8),
    ((1438, 320, 1745, 620), "048d0e79-413f-477a-9ecd-07b24b302489.png", "#0B0B0B", "Guinness", "£3.00", .8),
    ((2085, 320, 2392, 620), "e04f4376-1bd5-46f7-8503-e07d59277091.png", "#FFFFFF", "Peroni", "£5.00", .8),
    ((2408, 320, 2715, 620), "food.jpg", "cover", "FOOD", "›››", .8),
    ((792, 636, 1099, 937), "coca-cola.png", "#FFFFFF", "Coca-Cola", "£2.50", .8),
    ((1115, 636, 1422, 937), "40bf993b-bb19-442b-ba0f-d2560964607a.png", "#FFFFFF", "Diet Coke", "£2.50", .8),
    ((1438, 636, 1745, 937), "lemonade.jpg", "cover", "Lemonade", "£2.30", .8),
]}
ROBOTO = pathlib.Path("C:/Users/azureuser/develop/flutter/bin/cache/artifacts/material_fonts")


def _photo_tile(im, box, url, ground, name, price, k=1.0):
    import io
    import urllib.request
    from PIL import Image, ImageDraw, ImageFont
    x0, y0, x1, y1 = box
    w, h = x1 - x0 + 1, y1 - y0 + 1
    local = GO / "store" / "marketing" / "photos" / url
    data = local.read_bytes() if local.exists() else urllib.request.urlopen(PHOTO_BASE + url).read()
    logo = Image.open(io.BytesIO(data)).convert("RGBA")
    if ground == "cover":  # a photo: fill the tile, centred
        from PIL import ImageOps
        tile = ImageOps.fit(logo, (w, h), Image.LANCZOS, centering=(.55, .5))
    else:  # a logo: on its own ground in the top of the tile
        tile = Image.new("RGBA", (w, h), ground)
        logo.thumbnail((int(w * .78), int(h * .40)), Image.LANCZOS)
        tile.alpha_composite(logo, ((w - logo.width) // 2, int(h * .29 - logo.height / 2)))
    shade = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    for y in range(int(h * .52), h):  # the app's dark foot under the name
        a = min(1.0, (y - h * .52) / (h * .10))
        sd.line([(0, y), (w, y)], fill=(18, 18, 18, int(235 * a)))
    tile.alpha_composite(shade)
    d = ImageDraw.Draw(tile)
    fb = ImageFont.truetype(str(ROBOTO / "roboto-bold.ttf"), int(40 * k))
    fm = ImageFont.truetype(str(ROBOTO / "roboto-medium.ttf"), int(34 * k))
    d.text((26 * k, h - 92 * k), name, font=fb, fill=(255, 255, 255, 255), anchor="ls")
    d.text((26 * k, h - 38 * k), price, font=fm, fill=(225, 225, 225, 255), anchor="ls")
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), int(22 * k), fill=255)
    ImageDraw.Draw(tile).rounded_rectangle((0, 0, w - 1, h - 1), int(22 * k), outline=(255, 255, 255, 40), width=2)
    im.paste(tile, (x0, y0), mask)
    return im


def screen_file(src, shot, tablet=False):
    """The screenshot, with product photos on their tiles and any staff
    initials replaced by the Vesopa V."""
    from PIL import Image
    path = GO / "store" / "screenshots" / src / f"{shot}.png"
    im = Image.open(path).convert("RGBA")
    for args in PHOTOS.get((src, shot), []):
        im = _photo_tile(im, *args)
    for cx, cy, r, shape in AVATARS.get((src, shot), []):
        im = _badge(im, cx, cy, r, shape)
    im = _tall(im, tablet)
    out = pathlib.Path(R.tempfile.mkdtemp(prefix="vesopa-logo-shot-")) / f"{shot}.png"
    im.save(out)
    return out


def _tall(im, tablet=False):
    """A modern tall phone screen: a status bar above the app, the gesture bar
    below it, in the app's own top and bottom colours. An iPad's bars are the
    same, only thinner for its width."""
    from PIL import Image, ImageDraw, ImageFont
    w, h = im.size
    top, bottom = (int(w * .026), int(w * .016)) if tablet else (int(w * .12), int(w * .09))
    out = Image.new("RGBA", (w, h + top + bottom), im.getpixel((3, 2)))
    out.paste(Image.new("RGBA", (w, bottom), im.getpixel((3, h - 3))), (0, h + top))
    out.alpha_composite(im, (0, top))
    d = ImageDraw.Draw(out)
    fg = (255, 255, 255, 255)
    f = ImageFont.truetype(str(FONTS / "Montserrat-SemiBold.ttf"), int(top * .34))
    d.text((int(w * .08), top * .52), "9:41", font=f, fill=fg, anchor="lm")
    y, x = top * .52, w * (.97 if tablet else .92)
    u = top / 129  # the phone's icons were drawn for its 129 px bar
    d.rounded_rectangle((x - 58 * u, y - 15 * u, x, y + 15 * u), 6 * u, outline=fg, width=max(2, round(3 * u)))  # battery
    d.rounded_rectangle((x - 52 * u, y - 9 * u, x - 14 * u, y + 9 * u), 3 * u, fill=fg)
    d.rectangle((x + 2 * u, y - 6 * u, x + 6 * u, y + 6 * u), fill=fg)
    for i in range(4):                                                         # signal
        bh = (8 + i * 7) * u
        d.rectangle((x - (110 - i * 12) * u, y + 14 * u - bh, x - (102 - i * 12) * u, y + 14 * u), fill=fg)
    d.pieslice((x - 182 * u, y - 20 * u, x - 134 * u, y + 28 * u), 225, 315, fill=fg)  # wi-fi
    hb = h + top + bottom * .5
    hw = w * (.07 if tablet else .17)
    d.rounded_rectangle((w / 2 - hw, hb - 6, w / 2 + hw, hb + 6), 6, fill=(255, 255, 255, 230))
    return out


GO_LOGO = GO / "store" / "marketing" / "photos" / "go-logo.png"  # the real Vesopa Go icon


def _badge(im, cx, cy, r, shape):
    from PIL import Image, ImageDraw
    if shape == "box":  # the app's own logo slot: the real Vesopa Go icon
        n = int(r * 2)
        logo = Image.open(GO_LOGO).convert("RGBA").resize((n, n), Image.LANCZOS)
        mask = Image.new("L", (n, n), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, n - 1, n - 1), int(n * .24), fill=255)
        im.paste(logo, (int(cx - r), int(cy - r)), mask)
        return im
    size = int(r * 2 * 4)
    s = (size * .56) / (L.V_X1 - L.V_X0)
    vh = (L.BASE - L.TOP) * s
    vw = size * .56
    badge = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">'
             f'<defs>{L._defs("K", L.BLACK)}<linearGradient id="bl" x1="0" y1="0" x2="0" y2="1">'
             f'<stop offset="0" stop-color="#C9E540"/><stop offset="1" stop-color="#8BA812"/></linearGradient></defs>'
             + (f'<circle cx="{size / 2}" cy="{size / 2}" r="{size / 2}" fill="url(#bl)"/>' if shape == "circle" else
                f'<rect width="{size}" height="{size}" rx="{size * .24}" fill="url(#bl)"/>') +
             f'<g transform="translate({size / 2 - vw / 2 - L.V_X0 * s:.1f},{size / 2 + size * .02 - vh / 2 - L.TOP * s:.1f}) scale({s:.4f})">'
             f'{L.v_group("K", L.BLACK, glow=False)}</g></svg>')
    b = R.render_all([("b", badge, size, size)])["b"].resize((int(r * 2), int(r * 2)), Image.LANCZOS)
    im.alpha_composite(b, (int(cx - r), int(cy - r)))
    return im


def lockup():
    """The foot of each picture: the real Vesopa Go icon and its name in black,
    so all of it reads on the lime."""
    return (f'<div style="display:flex;align-items:center;gap:22px">'
            f'<img src="{GO_LOGO.as_uri()}" style="width:92px;height:92px;border-radius:22px;'
            f'box-shadow:0 8px 20px rgba(40,50,0,.35)">'
            f'<span style="font-family:Mont;font-weight:700;font-size:50px;color:#0A0A0A;letter-spacing:-.5px">'
            f'Vesopa Go</span></div>')


def headline(text):
    parts = text.split("*")
    return "".join(f'<em>{p}</em>' if i % 2 else p for i, p in enumerate(parts))


def page(shot, title, sub, d, i):
    W, H = d["W"], d["H"]
    head = d.get("head", 420)  # headline zone, the same on every frame so the devices line up
    foot = d.get("foot", 150)
    tablet = d.get("tablet", False)
    scr_path = screen_file(d["src"], shot, tablet)
    scr = scr_path.as_uri()
    # the screen's own aspect decides the frame's height
    from PIL import Image
    iw, ih = Image.open(scr_path).size
    fh = H - head - foot
    fw = (fh - 2 * d["bezel"]) * iw / ih + 2 * d["bezel"]
    glow_x = 30 + (i % 2) * 40  # the lime light swaps sides frame to frame
    if tablet:  # an iPad: even bezel, the camera on the long top edge, top buttons at the right
        body = f"""<div class="camera" style="top:{d['bezel'] / 2 - 9:.0f}px"></div>
    <div class="btn t" style="right:{fw * .07:.0f}px;width:{fw * .05:.0f}px"></div>
    <div class="btn t" style="right:{fw * .13:.0f}px;width:{fw * .05:.0f}px"></div>
    <div class="btn r" style="top:{fh * .08:.0f}px;height:{fh * .09:.0f}px"></div>"""
    else:
        body = f"""<div class="island"></div>
    <div class="btn r" style="top:{fh * .27:.0f}px;height:{fh * .11:.0f}px"></div>
    <div class="btn l" style="top:{fh * .17:.0f}px;height:{fh * .04:.0f}px"></div>
    <div class="btn l" style="top:{fh * .25:.0f}px;height:{fh * .07:.0f}px"></div>
    <div class="btn l" style="top:{fh * .34:.0f}px;height:{fh * .07:.0f}px"></div>"""
    return f"""<div class="pg" style="width:{W}px;height:{H}px">
  <div class="ring" style="left:{glow_x - 18}%;top:7%"></div>
  <div class="ring2" style="left:{glow_x - 60}%;top:42%"></div>
  <div class="head" style="height:{head}px"><h1>{headline(title)}</h1><p class="sub">{sub}</p></div>
  <div class="phone" style="width:{fw:.0f}px;height:{fh:.0f}px;border-radius:{d['radius']}px;padding:{d['bezel']}px">
    <img src="{scr}" style="border-radius:{d['radius'] - d['bezel']}px">
    {body}
    <div class="shine" style="border-radius:{d['radius']}px"></div>
  </div>
  <div class="logo">{lockup()}</div>
</div>"""


def css(k=1.0):
    return f"""
@font-face {{ font-family: Mont; src: url("{(FONTS / 'Montserrat-Bold.ttf').as_uri()}"); font-weight: 700; }}
@font-face {{ font-family: Mont; src: url("{(FONTS / 'Montserrat-Medium.ttf').as_uri()}"); font-weight: 500; }}
body {{ margin: 0; }}
.pg {{ position: relative; overflow: hidden; display: flex; flex-direction: column; align-items: center;
       background: linear-gradient(180deg, #B4D31E 0%, {LIME} 55%, #98B813 100%); font-family: Mont, sans-serif; }}
.ring {{ position: absolute; width: {1180 * k:.0f}px; height: {1180 * k:.0f}px; border-radius: 50%; background: rgba(255,255,255,.13); }}
.ring2 {{ position: absolute; width: {1300 * k:.0f}px; height: {1300 * k:.0f}px; border-radius: 50%; background: rgba(255,255,255,.08); }}
.head {{ position: relative; display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: {46 * k:.0f}px; box-sizing: border-box; }}
h1 {{ position: relative; margin: 0 60px; color: #0A0A0A; font-weight: 500; font-size: {82 * k:.0f}px; line-height: 1.08;
      text-align: center; letter-spacing: -1px; }}
h1 em {{ font-style: normal; font-weight: 700; }}
.sub {{ position: relative; margin: {26 * k:.0f}px 80px 0; color: #2A3108; font-weight: 500; font-size: {40 * k:.0f}px; text-align: center; }}
.phone {{ position: relative; box-sizing: border-box; background: #050505;
          border: 9px solid transparent;
          background-image: linear-gradient(#050505, #050505), linear-gradient(135deg, #9A9EA2, #4C5054 30%, #7C8085 55%, #3E4246 80%, #8C9094);
          background-origin: border-box; background-clip: padding-box, border-box;
          box-shadow: 0 40px 80px rgba(40,50,0,.45); }}
.island {{ position: absolute; top: 40px; left: 50%; width: 190px; height: 54px; margin-left: -95px; border-radius: 27px; background: #000; }}
.island::after {{ content: ""; position: absolute; right: 20px; top: 17px; width: 20px; height: 20px; border-radius: 50%;
                  background: radial-gradient(circle at 40% 40%, #2E3A5A 0%, #0A0C14 65%); }}
.btn {{ position: absolute; width: 7px; background: linear-gradient(90deg, #5A5E62, #8C9094); }}
.btn.r {{ right: -16px; border-radius: 0 4px 4px 0; }}
.btn.l {{ left: -16px; border-radius: 4px 0 0 4px; }}
.btn.t {{ top: -16px; height: 7px; border-radius: 4px 4px 0 0; background: linear-gradient(180deg, #5A5E62, #8C9094); }}
.camera {{ position: absolute; left: 50%; width: 18px; height: 18px; margin-left: -9px; border-radius: 50%;
           background: radial-gradient(circle at 40% 40%, #2E3A5A 0%, #0A0C14 65%); }}
.phone img {{ width: 100%; display: block; }}
.shine {{ position: absolute; inset: 0; background: linear-gradient(125deg, rgba(255,255,255,.14) 0%, rgba(255,255,255,0) 32%); pointer-events: none; }}
.logo {{ position: absolute; bottom: {30 * k:.0f}px; zoom: {k}; }}
"""


def build(device):
    d = DEVICES[device]
    out = GO / "store" / "marketing" / device
    out.mkdir(parents=True, exist_ok=True)
    for i, (shot, title, sub) in enumerate(SHOTS):
        html = f"<html><head><meta charset='utf-8'><style>{css(d.get('k', 1.0))}</style></head><body>{page(shot, title, sub, d, i)}</body></html>"
        im = R._shoot(html, d["W"], d["H"]).convert("RGB")
        im.save(out / f"{shot}.png", optimize=True)
        print(out.relative_to(GO) / f"{shot}.png")


if __name__ == "__main__":
    for dev in sys.argv[1:] or ["android"]:
        build(dev)
