"""Vesopa Go for Android, the promo film (2026-11-04).

The owner's reference is ICRTouch's PocketTouch film again (logo reveal, the
tagline with the phone flying in, an arc of features, venue footage, the
phone with call-outs and a tapping hand, "no more pen and paper", the devices
it runs on, a promise, the benefits, the call to action). This keeps that
rhythm but is its own film: it opens on Vesopa Go itself, then an Android phone
(punch hole, not an island), a real sale tapped through from Pay to QR to Paid,
the Android devices it runs on, a lime "drop" on the promise, a Google Play
badge, a score, and sound effects on every tap and move. The owner cut the pub
cold open and "no more pen and paper" (2026-11-04).

The voice is Kokoro (an open TTS model run here with onnxruntime, British
"bf_emma"), read a phrase at a time with real pauses between, because the owner
found one long read breathless and flat. Each scene's phrase timings are kept
in voice/timing.json, and the chips, the benefits and the promise appear on
their words. The model files (kokoro-v1.0.onnx, voices-v1.0.bin, from
github.com/thewh1teagle/kokoro-onnx releases) live outside the repo, in KOKORO_DIR.

    python tool/make_android_film.py voice    # the voiceover, a phrase at a time; scene lengths follow it
    python tool/make_android_film.py film     # the picture (STILLS=3,20.5 for a few frames only)
    python tool/make_android_film.py audio    # score, effects, voice, mixed and muxed; captions
    python tool/make_android_film.py all

Layers come from headless Edge (make_promo_video's helpers); motion is done
here frame by frame; ffmpeg encodes. 1920x1080, 30 fps.
Writes store/marketing/video/android-film/: vesopa-go-android.mp4 (with sound),
vesopa-go-android.srt, and the stems.
"""
import json
import math
import os
import pathlib
import subprocess
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

GO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GO / "tool"))
import make_promo_video as P  # noqa: E402
from make_store_video import FPS, H, W, ease, put  # noqa: E402

S, V = P.S, P.V
LIME, INK = P.LIME, P.INK
OUT = GO / "store" / "marketing" / "video" / "android-film"
VOICE = "bf_emma"
KOKORO = pathlib.Path(os.environ.get("KOKORO_DIR", pathlib.Path.home() / "scratch" / "kokoro"))
RATE = 44100
P.ICON.update({"phone": "e32c", "tab": "e330"})


# ---- the Android phone ------------------------------------------------------------
BEZEL, BORDER, RADIUS = 18, 9, 64


def android_layer(shot, fh=900):
    """The store screen in an Android phone: even thin bezel, a punch-hole
    camera, power and volume on the right."""
    d = S.DEVICES["android"]
    path = S.screen_file(d["src"], shot)
    iw, ih = Image.open(path).size
    fw = (fh - 2 * BEZEL - 2 * BORDER) * iw / ih + 2 * BEZEL + 2 * BORDER
    body = f"""<div style="padding:60px 40px;display:inline-block">
  <div class="phone" style="width:{fw:.0f}px;height:{fh}px;border-radius:{RADIUS}px;padding:{BEZEL}px">
    <img src="{path.as_uri()}" style="border-radius:{RADIUS - BEZEL - 6}px">
    <div style="position:absolute;top:{BEZEL + 20}px;left:50%;width:26px;height:26px;margin-left:-13px;border-radius:50%;
      background:radial-gradient(circle at 40% 40%,#2E3A5A 0%,#05060A 60%);box-shadow:0 0 0 3px #000"></div>
    <div class="btn r" style="top:{fh * .20:.0f}px;height:{fh * .07:.0f}px"></div>
    <div class="btn r" style="top:{fh * .31:.0f}px;height:{fh * .13:.0f}px"></div>
    <div class="shine" style="border-radius:{RADIUS}px"></div>
  </div></div>"""
    im = S.R._shoot(V.html(body), int(fw) + 80, fh + 120)
    return im.crop(im.getbbox())


def screen_xy(ph, px, py, pt):
    """A point on the 1080-wide screenshot, in frame pixels, measured from the
    phone's solid body (the layer's edges include the shadow)."""
    bx0, by0, bx1, by1 = ph.getchannel("A").point(lambda a: 255 if a > 250 else 0).getbbox()
    bx1 -= 16  # the buttons stick out on the right
    inset = BEZEL + BORDER
    s = (bx1 - bx0 - 2 * inset) / 1080
    return px + bx0 + inset + pt[0] * s, py + by0 + inset + pt[1] * s


def find_colour(shot, test, rows=None):
    """Bounding box (screenshot pixels, status bar included) of pixels passing test."""
    im = Image.open(S.screen_file("android-phone", shot)).convert("RGB")
    if rows:
        im = im.crop((0, rows[0], im.width, rows[1]))
    a = np.asarray(im).astype(int)
    ys, xs = np.nonzero(test(a[..., 0], a[..., 1], a[..., 2]))
    off = rows[0] if rows else 0
    return xs.min(), ys.min() + off, xs.max(), ys.max() + off


def tablet_layer(width=760):
    """An Android tablet: the plain iPad sale screen (the same app) in a black slab."""
    src = GO / "store" / "raw-screens-ipad-13" / "01-sale.png"
    iw, ih = Image.open(src).size
    sh = width * ih / iw
    return P.shoot(f"""<div style="padding:40px"><div style="width:{width}px;height:{sh:.0f}px;padding:22px;border-radius:40px;
      background:#050505;box-shadow:0 0 0 5px #3A3E42, 0 30px 70px rgba(0,0,0,.55);position:relative">
      <img src="{src.as_uri()}" style="width:100%;height:100%;border-radius:18px;display:block">
      <div style="position:absolute;top:7px;left:50%;width:10px;height:10px;margin-left:-5px;border-radius:50%;background:#1A1E2A"></div>
      </div></div>""", width + 140, int(sh) + 140)


def play_badge(scale=1.0):
    k = scale
    tri = (f'<svg width="{56 * k:.0f}" height="{62 * k:.0f}" viewBox="0 0 56 62">'
           '<path d="M2 2 L32 31 L2 60 Z" fill="#00D7FE"/><path d="M2 2 L42 24 L32 31 Z" fill="#00F076"/>'
           '<path d="M2 60 L32 31 L42 38 Z" fill="#FF3A44"/><path d="M42 24 L54 31 L42 38 L32 31 Z" fill="#FFD400"/></svg>')
    return P.shoot(f"""<div style="padding:10px"><div style="display:flex;align-items:center;gap:{22 * k:.0f}px;padding:{18 * k:.0f}px {38 * k:.0f}px;
      background:#000;border:{3 * k:.0f}px solid #A6A6A6;border-radius:{22 * k:.0f}px;font-family:Mont;color:#FFF">{tri}
      <div><div style="font-weight:500;font-size:{24 * k:.0f}px;letter-spacing:1px">GET IT ON</div>
      <div style="font-weight:700;font-size:{56 * k:.0f}px;line-height:1;letter-spacing:-1px">Google Play</div></div></div></div>""",
                   int(520 * k), int(200 * k))


def caption(markup, size=84, width=980):
    return P.text(markup, size=size, width=width, align="left", lh=1.08)


def chip_row(lines):
    """A lime call-out bubble."""
    return P.bubble(lines, 440)


# ---- the plan ------------------------------------------------------------------------
# Each scene: name, seconds at least, the voice as phrases (a phrase, or (phrase,
# pause after it)), when the voice starts in the scene, whether the scene cuts in
# hard (on the beat) instead of cross-fading, and the reading speed.
P_SHORT, P_MID, P_LONG = .22, .38, .6
SCENES = [
    ("logo", 4.8, [("Meet Vesopa Go.", 0)], 1.7, False, .92),
    ("tagline", 5.0, [("Your whole till,", P_SHORT), ("right in your pocket.", P_LONG),
                      ("Orders and payments, on any Android phone.", 0)], .35, False, .95),
    ("arc", 5.2, [("Your menu.", P_SHORT), ("Your tables.", P_SHORT), ("The kitchen.", P_SHORT),
                  ("Allergens.", P_SHORT), ("And payments.", P_MID), ("All in one place.", 0)], .45, False, .95),
    ("table", 3.2, [("Take the order, right at the table.", 0)], .35, True, .95),
    ("pass", 3.4, [("And before you're back at the bar,", P_SHORT), ("it's already in the kitchen.", 0)], .25, True, .97),
    ("d_sale", 3.2, [("Add the drinks.", P_MID), ("Then tap Pay.", 0)], .3, False, .93),
    ("d_pay", 3.4, [("Cash. Card. Tap to Pay. Or QR.", P_MID), ("However your guests like to pay.", 0)], .25, False, .95),
    ("d_qr", 3.2, [("With QR Pay, they simply scan,", P_SHORT), ("pay,", P_SHORT), ("and go.", 0)], .25, False, .93),
    ("d_paid", 3.4, [("Paid!", P_MID), ("And the receipt is printed, or emailed, in one tap.", 0)], .25, False, .95),
    ("devices", 5.0, [("Use it on Android phones,", P_SHORT), ("on the Dojo Pocket,", P_SHORT),
                      ("and on Android tablets.", 0)], .45, False, .95),
    ("drop", 4.4, [("Work faster.", P_MID), ("Serve more.", 0)], .55, True, .9),
    ("benefits", 5.4, [("Quicker service.", P_SHORT), ("Bigger orders.", P_SHORT), ("Happier guests.", P_MID),
                       ("And a team that's always in step.", 0)], .35, False, .95),
    ("cta", 4.6, [("Get Vesopa Go on Google Play,", P_SHORT), ("or visit go dot vesopa dot com.", 0)], .35, False, .95),
    ("end", 4.0, [("Vesopa Go.", P_MID), ("Orders and payments, anywhere.", 0)], .45, False, .9),
]
CAPTIONS = {"cta": "Get Vesopa Go on Google Play, or visit go.vesopa.com."}
XF = .35


def voice_path(i):
    return OUT / "voice" / f"line_{i:02d}.wav"


def probe(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                 str(path)], capture_output=True, text=True).stdout)


def phrases(name):
    """When each phrase of a scene's voice starts, in seconds from the scene's start."""
    i, sc = next((i, sc) for i, sc in enumerate(SCENES) if sc[0] == name)
    tf = OUT / "voice" / "timing.json"
    offs = json.loads(tf.read_text())[name] if tf.exists() else [k * 1.0 for k in range(len(sc[2]))]
    return [sc[3] + o for o in offs]


def line_text(phr):
    return " ".join(x if isinstance(x, str) else x[0] for x in phr)


def timeline():
    """[(start, dur, name, line, line_at, cut)] with each scene long enough for its voice."""
    rows, t = [], 0.0
    for i, (name, dur, phr, at, cut, _) in enumerate(SCENES):
        line = line_text(phr)
        vp = voice_path(i)
        if line and vp.exists():
            dur = max(dur, at + probe(vp) + .45)
        rows.append((t, dur, name, line, at, cut))
        t += dur
    return rows


def make_voice():
    """Each scene's phrases read one at a time and joined with their pauses, so
    the voice breathes; the phrase starts go to voice/timing.json."""
    from kokoro_onnx import Kokoro
    k = Kokoro(str(KOKORO / "kokoro-v1.0.onnx"), str(KOKORO / "voices-v1.0.bin"))
    (OUT / "voice").mkdir(parents=True, exist_ok=True)
    timing = {}

    def trimmed(x, sr):
        on = np.nonzero(np.abs(x) > .012)[0]
        if not len(on):
            return x
        a_, b_ = max(0, on[0] - int(.015 * sr)), min(len(x), on[-1] + int(.06 * sr))
        y = x[a_:b_].copy()
        f = int(.01 * sr)
        y[:f] *= np.linspace(0, 1, f)
        y[-f:] *= np.linspace(1, 0, f)
        return y

    for i, (name, dur, phr, at, _, speed) in enumerate(SCENES):
        parts, offs, t = [], [], 0.0
        for x in phr:
            text, pause = (x, P_SHORT) if isinstance(x, str) else x
            sig, sr = k.create(text, voice=VOICE, speed=speed, lang="en-gb")
            sig = trimmed(np.asarray(sig, dtype=np.float32), sr)
            offs.append(round(t, 3))
            parts += [sig, np.zeros(int(pause * sr), dtype=np.float32)]
            t += len(sig) / sr + pause
        y = np.concatenate(parts)
        y = y / (np.max(np.abs(y)) + 1e-9) * .89
        with wave.open(str(voice_path(i)), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((y * 32767).astype(np.int16).tobytes())
        timing[name] = offs
        d = len(y) / sr
        print(f"{name:9s} {d:4.1f}s  (scene {dur}s, voice at {at}s){'  -> scene grows' if at + d + .45 > dur else ''}")
    (OUT / "voice" / "timing.json").write_text(json.dumps(timing, indent=1))
    print(f"film length {sum(r[1] for r in timeline()):.1f}s")


# ---- the picture ---------------------------------------------------------------------
def make_film():
    OUT.mkdir(parents=True, exist_ok=True)
    print("drawing layers")
    bg = P.background()
    icon, word = P.logo_reveal()
    # the icon again on a canvas big enough for its whole glow (logo_reveal's clips it square)
    icon = P.shoot(f'<div style="padding:130px"><img src="{S.GO_LOGO.as_uri()}" style="width:300px;height:300px;'
                   f'border-radius:70px;display:block;box-shadow:0 0 90px rgba(165,199,21,.45)"></div>', 600, 600)
    for_android = P.shoot('<div style="font-family:Mont;font-weight:500;font-size:56px;color:#D8DCD2;letter-spacing:6px">FOR ANDROID</div>', 700, 120)
    flow = ["01-sale", "02-pay", "03-qr-pay", "05-approved"]
    phones = {s: android_layer(s, fh=900) for s in flow}
    hero = android_layer("01-sale", fh=860)
    small_pay = android_layer("02-pay", fh=640)
    small_sale = android_layer("01-sale", fh=640)
    tablet = tablet_layer(780)
    badge = play_badge(1.25)
    tag = caption("Your whole till, *in your pocket*", size=96, width=900)
    tag_sub = P.shoot('<div style="font-family:Mont;font-weight:500;font-size:44px;color:#BFC4B8;width:880px;line-height:1.3">'
                      'Orders and payments on any Android phone</div>', 920, 200)
    chips = [P.feature_chip(n, l) for n, l in (("menu", "Menu"), ("table", "Tables"), ("kitchen", "Kitchen"),
                                               ("allergen", "Allergens"), ("card", "Payments"))]
    cap_table = V.footage_text("Take the order *at the table*", "The full menu, photos and allergens")
    cap_pass = V.footage_text("At the pass *in seconds*", "Straight to the kitchen printer or screen")
    demo = {
        "d_sale": (chip_row(["Add the items"]), chip_row(["Then:", "tap Pay"])),
        "d_pay": (chip_row(["Every way to pay"]), chip_row(["Guests can:", "pay cash", "pay by card", "Tap to Pay", "scan a QR"])),
        "d_qr": (chip_row(["QR Pay"]), chip_row(["Guests:", "scan the code", "pay on their phone", "and go"])),
        "d_paid": (chip_row(["Paid. Done."]), chip_row(["Receipt:", "print it", "or email it"])),
    }
    touch = P.shoot(P.icon_html("touch", 150, "#FFFFFF"), 200, 200)
    dev_labels = [P.shoot(f'<div style="display:flex;align-items:center;gap:14px;font-family:Mont;font-weight:700;font-size:44px;color:{c}">'
                          f'{P.icon_html(i, 54, c)}{t}</div>', 620, 90)
                  for i, t, c in (("android", "Android phones", "#FFFFFF"), ("card", "Dojo Pocket", INK), ("tab", "Android tablets", INK))]
    # on lime, the lime words go white
    drop = [P.shoot(f'<div style="font-family:Mont;font-weight:500;font-size:150px;color:{INK};letter-spacing:-2px;white-space:nowrap">'
                    f'{a} <b style="color:#FFF">{b}</b></div>', 1100, 300) for a, b in (("Work", "faster."), ("Serve", "more."))]
    benefits = [P.benefit("clock", "Quicker", "service"), P.benefit("trend", "Bigger", "orders"),
                P.benefit("thumb", "Happier", "guests"), P.benefit("team", "A team", "always in step")]
    cta = caption("Get *Vesopa Go* today", size=100, width=900)
    url = P.shoot(f'<div style="font-family:Mont;font-weight:700;font-size:58px;color:{LIME}">go.vesopa.com</div>', 700, 120)
    end_line = P.shoot('<div style="font-family:Mont;font-weight:500;font-size:48px;color:#D8DCD2">Orders &amp; payments, anywhere</div>', 1000, 120)

    print("reading footage")
    f_table = V.clip("m1_menu", 1.0, 4.0)
    f_pass = V.clip("v3_pass", .3, 4.6)

    # where things are on the screens (screenshot pixels, status bar included)
    sale_tap = (905, 1496 + 130)
    pay_tap = (930, 1138 + 130)
    qr_box = find_colour("03-qr-pay", lambda r, g, b: (r > 245) & (g > 245) & (b > 245), rows=(150, 1300))
    ok_box = find_colour("05-approved", lambda r, g, b: (g > 150) & (r < 90) & (b < 140) & (g - r > 80))

    def center(ph):
        return W / 2 - ph.width / 2, H / 2 - ph.height / 2 + 10

    def footage(frames, cap, f, u, d):
        f.paste(frames[min(int(u * FPS), len(frames) - 1)], (0, 0))
        f.alpha_composite(V.shade())
        if cap is not None:
            k = ease((u - .25) / .7)
            put(f, cap, 120 - (1 - k) * 60, H - cap.height - 140, alpha=min(k, 1 - ease((u - (d - .35)) / .35)))

    def s_logo(f, u, d):
        k = ease(u / .8)
        put(f, P.rotated(icon, (1 - k) * -30), W / 2 - icon.width / 2 - 430 * ease((u - .9) / .7), H / 2 - icon.height / 2 - 40,
            alpha=k, scale=.5 + .5 * k)
        P.wipe(f, word, W / 2 - 210, H / 2 - word.height / 2 - 60, ease((u - 1.1) / .8))
        put(f, for_android, W / 2 - 200, H / 2 + 70, alpha=ease((u - 1.7) / .6))

    def s_tagline(f, u, d):
        k = ease((u - .15) / .8)
        put(f, tag, 130 - (1 - k) * 80, H / 2 - tag.height / 2 - 70, alpha=k)
        put(f, tag_sub, 130, H / 2 + tag.height / 2 - 40, alpha=ease((u - phrases("tagline")[2]) / .6))
        fl = ease(u / 1.0)
        r = P.rotated(hero, 12 - 5 * fl + math.sin(u * .9) * .8)
        x = 1400 - r.width / 2 + (1 - fl) * 950
        y = H / 2 - r.height / 2 + (1 - fl) * 140 + math.sin(u * 1.3) * 8
        if fl < .95:
            for g, a in ((170, .16), (85, .28)):
                put(f, r, x + g * (1 - fl), y + g * (1 - fl) * .15, alpha=a)
        put(f, r, x, y)

    def s_arc(f, u, d):
        ph = phones["02-pay"]
        cx, cy = W / 2, H + 120
        k = ease(u / .7)
        put(f, ph, W / 2 - ph.width / 2, H - ph.height * .52 + (1 - k) * 300, alpha=k)
        P.arc(f, int(cx), int(cy), 800, ease((u - .2) / 1.4), width=10)
        for i, (c, ph_at) in enumerate(zip(chips, phrases("arc"))):
            a = math.radians(180 + 18 + i * 36)
            kx = ease((u - ph_at + .05) / .4)
            x = cx + 800 * math.cos(a) - c.width / 2
            y = cy + 800 * math.sin(a) - c.height / 2
            put(f, c, x, y, alpha=kx, scale=.4 + .6 * kx + .08 * math.sin(kx * math.pi))

    def s_table(f, u, d):
        footage(f_table, cap_table, f, u, d)

    def s_pass(f, u, d):
        footage(f_pass, cap_pass, f, u, d)

    def s_demo(key, shot):
        left, right = demo[key]

        def draw(f, u, d):
            ph = phones[shot]
            px, py = center(ph)
            first = key == "d_sale"
            put(f, ph, px + (0 if not first else (1 - ease(u / .6)) * 200), py, alpha=ease(u / .5) if first else 1)
            put(f, left, 120 - (1 - ease((u - .3) / .5)) * 120, 300, alpha=ease((u - .3) / .5))
            put(f, right, W - 120 - right.width + (1 - ease((u - .7) / .5)) * 120, 480, alpha=ease((u - .7) / .5))
            if key == "d_sale":  # the press lands on "tap Pay"
                hx, hy = screen_xy(ph, px, py, sale_tap)
                P.hand(f, hx, hy, (u - (phrases("d_sale")[1] - .05)) / 1.1, touch)
            if key == "d_pay":
                hx, hy = screen_xy(ph, px, py, pay_tap)
                P.hand(f, hx, hy, (u - (d - 1.45)) / 1.1, touch)
            if key == "d_qr":  # a scan line sweeps the code
                x0, y0, x1, y1 = qr_box
                ax, ay = screen_xy(ph, px, py, (x0, y0))
                bx, by = screen_xy(ph, px, py, (x1, y1))
                k = (u - .6) / 1.6
                if 0 < k < 1:
                    yy = ay + (by - ay) * (.5 - .5 * math.cos(k * 2 * math.pi))
                    lay = Image.new("RGBA", f.size, (0, 0, 0, 0))
                    ImageDraw.Draw(lay).rectangle((ax - 10, yy - 3, bx + 10, yy + 3), fill=(165, 199, 21, 230))
                    f.alpha_composite(lay.filter(ImageFilter.GaussianBlur(3)))
                    f.alpha_composite(lay)
            if key == "d_paid":  # rings burst out of the tick
                x0, y0, x1, y1 = ok_box
                cx, cy = screen_xy(ph, px, py, ((x0 + x1) / 2, (y0 + y1) / 2))
                for j in range(3):
                    k = (u - .15 - j * .18) / .9
                    if 0 < k < 1:
                        lay = Image.new("RGBA", f.size, (0, 0, 0, 0))
                        r = 60 + 260 * ease(k)
                        ImageDraw.Draw(lay).ellipse((cx - r, cy - r, cx + r, cy + r), outline=(165, 199, 21, int(220 * (1 - k))), width=6)
                        f.alpha_composite(lay)
        return draw

    grounds = [("#1B1F22", 0), (LIME, 1), ("#E9E9E9", 2)]

    def s_devices(f, u, d):
        pw = W / 3
        for (ground, i), label in zip(grounds, dev_labels):
            k = ease((u - i * .22) / .7)
            if k <= 0:
                continue
            yo = (1 - k) * H
            lay = Image.new("RGBA", (int(pw) + 2, H), ground)
            f.alpha_composite(lay, (int(i * pw), int(yo)))
            if i == 0:
                ph = small_sale
                f.alpha_composite(ph, (int(i * pw + pw / 2 - ph.width / 2), int(90 + yo)))
            elif i == 1:
                ph = small_pay
                f.alpha_composite(ph, (int(i * pw + pw / 2 - ph.width / 2), int(90 + yo)))
            else:
                t = tablet.resize((int(tablet.width * .72), int(tablet.height * .72)), Image.LANCZOS)
                f.alpha_composite(t, (int(i * pw + pw / 2 - t.width / 2), int(300 + yo)))
            put(f, label, i * pw + pw / 2 - label.width / 2, H - 150 + yo, alpha=1)

    def s_drop(f, u, d):
        k = ease(u / .45)
        lay = Image.new("RGBA", f.size, LIME)
        f.alpha_composite(lay, (int((1 - k) * W), 0))
        if k >= 1:
            ImageDraw.Draw(f).ellipse((W - 900, -500, W + 500, 900), fill=(186, 214, 70, 255))
            ImageDraw.Draw(f).ellipse((-600, 500, 700, 1800), fill=(176, 207, 50, 255))
        for j, (lay_, ph_at) in enumerate(zip(drop, phrases("drop"))):
            kt = ease((u - ph_at + .1) / .45)
            y = H / 2 - lay_.height - 10 + j * (lay_.height + 20)
            put(f, lay_, W / 2 - lay_.width / 2 + (1 - kt) * (-80 if j == 0 else 80), y, alpha=kt, scale=1.12 - .12 * kt)

    def s_benefits(f, u, d):
        ph = phones["05-approved"]
        sc = .82
        small = ph.resize((int(ph.width * sc), int(ph.height * sc)), Image.LANCZOS)
        k = ease(u / .7)
        put(f, small, W - 220 - small.width + (1 - k) * 300, H / 2 - small.height / 2 + math.sin(u * 1.2) * 6, alpha=k)
        for i, (b, ph_at) in enumerate(zip(benefits, phrases("benefits"))):
            kb = ease((u - ph_at + .05) / .5)
            put(f, b, 200 - (1 - kb) * 80, 220 + i * 170, alpha=kb)

    def s_cta(f, u, d):
        k = ease(u / .7)
        r = P.rotated(hero, -6)
        put(f, r, 1380 - r.width / 2 + (1 - k) * 300, H / 2 - r.height / 2 + math.sin(u * 1.2) * 6, alpha=k)
        put(f, cta, 140, 250 - (1 - ease((u - .2) / .6)) * 40, alpha=ease((u - .2) / .6))
        kb = ease((u - .7) / .6)
        put(f, badge, 140, 520, alpha=kb, scale=.85 + .15 * kb)
        put(f, url, 160, 770, alpha=ease((u - 1.1) / .6))

    def s_end(f, u, d):
        k = ease(u / .8)
        put(f, icon, W / 2 - icon.width / 2, 80 - (1 - k) * 30, alpha=k, scale=.8 + .2 * k)
        put(f, word, W / 2 - word.width / 2, 560, alpha=ease((u - .3) / .8))
        put(f, end_line, W / 2 - end_line.width / 2, 790, alpha=ease((u - .6) / .8))

    draws = {"logo": s_logo, "tagline": s_tagline, "arc": s_arc, "table": s_table, "pass": s_pass,
             "d_sale": s_demo("d_sale", "01-sale"), "d_pay": s_demo("d_pay", "02-pay"),
             "d_qr": s_demo("d_qr", "03-qr-pay"), "d_paid": s_demo("d_paid", "05-approved"),
             "devices": s_devices, "drop": s_drop, "benefits": s_benefits, "cta": s_cta, "end": s_end}
    rows = timeline()
    total = sum(r[1] for r in rows)
    n = int(total * FPS)

    def frame_at(idx, u):
        st, d, name = rows[idx][:3]
        f = bg.copy()
        draws[name](f, u, d)
        return f

    def at(t):
        idx = next(k for k, r in enumerate(rows) if t < r[0] + r[1] or k == len(rows) - 1)
        st, d = rows[idx][:2]
        f = frame_at(idx, t - st)
        if idx + 1 < len(rows) and not rows[idx + 1][5] and t > st + d - XF:
            f = Image.blend(f, frame_at(idx + 1, 0.0), ease((t - (st + d - XF)) / XF))
        return f

    stills = [float(s) for s in os.environ.get("STILLS", "").split(",") if s]
    if stills:
        for t in stills:
            at(t).convert("RGB").save(OUT / f"still_{t:05.1f}.png")
        print("stills written")
        return
    mp4 = OUT / "picture.mp4"
    ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                           "-preset", "medium", "-crf", "18", "-movflags", "+faststart", str(mp4)], stdin=subprocess.PIPE)
    print(f"encoding {n} frames ({total:.1f}s)")
    for i in range(n):
        ff.stdin.write(at(i / FPS).convert("RGB").tobytes())
        if i % 300 == 0:
            print(f"  {i}/{n}", flush=True)
    ff.stdin.close()
    ff.wait()
    print(mp4.relative_to(GO), f"{total:.1f}s")


# ---- the sound ---------------------------------------------------------------------------
rng = np.random.default_rng(11)


def hz(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def env_t(dur):
    return np.arange(int(dur * RATE)) / RATE


def pluck(f, dur=.9):
    t = env_t(dur)
    w = sum(np.sin(2 * np.pi * f * m * t) / m ** 1.3 * np.exp(-t * (4 + 3 * m)) for m in range(1, 7))
    return w * np.minimum(1, t / .003)


def pad(f, dur):
    t = env_t(dur)
    w = sum(np.sin(2 * np.pi * f * m * t + p) for m, p in ((1, 0), (1.005, 1.3), (.995, 2.1), (2, .5), (1.5, 2.9)))
    return w / 5 * np.clip(np.minimum(t / 1.0, (dur - t) / 1.0), 0, 1)


def sub(f, dur):
    t = env_t(dur)
    return (np.sin(2 * np.pi * f * t) + .2 * np.sin(4 * np.pi * f * t)) * np.minimum(1, t / .01) * np.exp(-t * 2.2)


def kick():
    t = env_t(.4)
    f = 42 + 95 * np.exp(-t * 32)
    return np.sin(2 * np.pi * np.cumsum(f) / RATE) * np.exp(-t * 8)


def noise(dur, decay, bright=1):
    n = rng.standard_normal(int(dur * RATE))
    for _ in range(bright):
        n = np.diff(n, prepend=0)
    n /= np.max(np.abs(n)) + 1e-9
    return n * np.exp(-env_t(dur)[:len(n)] * decay)


def whoosh(dur=.55, up=True):
    n = int(dur * RATE)
    x = np.linspace(0, 1, n)
    shape = np.sin(np.pi * x) ** 2 if not up else x ** 2 * (1 - x) * 6.75
    raw = rng.standard_normal(n)
    lo = np.convolve(raw, np.ones(18) / 18, mode="same")
    return (raw - lo) * .3 * shape + lo * 2.2 * shape


def tap():
    t = env_t(.08)
    return (np.sin(2 * np.pi * 2100 * t) * .6 + noise(.08, 0, 2)[:len(t)] * .5) * np.exp(-t * 70)


def blip(f):
    t = env_t(.18)
    return np.sin(2 * np.pi * f * t) * np.exp(-t * 22) * np.minimum(1, t / .002)


def chime():
    out = np.zeros(int(1.6 * RATE))
    for at_, n in ((0, 88), (.11, 95)):
        t = env_t(1.4)
        s = (np.sin(2 * np.pi * hz(n) * t) + .35 * np.sin(2 * np.pi * hz(n) * 2.01 * t)) * np.exp(-t * 3.5)
        i = int(at_ * RATE)
        out[i:i + len(s)] += s
    return out


def make_audio():
    rows = timeline()
    total_s = sum(r[1] for r in rows)
    start = {r[2]: r[0] for r in rows}
    dur = {r[2]: r[1] for r in rows}
    total = int((total_s + 1) * RATE)
    L, R = np.zeros(total), np.zeros(total)

    def add(sig, at, vol, pan=0.0):
        i = int(at * RATE)
        if i >= total or at < 0:
            return
        s = sig[:total - i] * vol
        L[i:i + len(s)] += s * math.sqrt((1 - pan) / 2) * 1.4
        R[i:i + len(s)] += s * math.sqrt((1 + pan) / 2) * 1.4

    # ---- score: 112 bpm, E major, C#m - A - E - B, pluck arps over pads
    bpm = 112
    beat = 60 / bpm
    bar = beat * 4
    prog = [(49, [61, 64, 68, 73]), (45, [61, 64, 69, 73]), (40, [59, 64, 68, 71]), (47, [59, 63, 66, 71])]

    def level(t):
        if t < start["tagline"]:
            return 0    # the logo: pads and plucks
        if t < start["table"]:
            return 1
        if t < start["devices"]:
            return 2
        if t < start["drop"]:
            return .5   # it pulls back under the devices and builds to the drop
        if t < start["end"]:
            return 3
        return 4

    t, c = 0.0, 0
    while t < total_s:
        root, ch = prog[c % 4]
        lv = level(t)
        add(sum(pad(hz(m), bar + 1.2) for m in ch), t, .05 if lv < 3 else .065)
        if lv < 4:
            for e in range(8):
                te = t + e * beat / 2
                if te > start["end"] + .2:
                    break
                note = ch[[0, 2, 1, 3, 2, 1, 3, 2][e]] + 12
                add(pluck(hz(note)), te, (.10 if e % 2 == 0 else .07) * (1.15 if lv >= 2 else 1), .35 if e % 2 else -.35)
        if lv >= 1:
            for b in (0, 1.5, 2, 3.5):
                add(sub(hz(root - 12), beat * 1.2), t + b * beat, .26 if lv >= 2 else .18)
        for b in range(4):
            tb = t + b * beat
            if tb > start["end"]:
                break
            if lv >= 2:
                add(kick(), tb, .55)
                if b % 2:
                    add(noise(.22, 16, 1), tb, .17, .1)  # clap
                for h in (.5,):
                    add(noise(.05, 80, 3), tb + h * beat, .05, .4)  # off-beat hat
            elif lv >= 1 and b == 0:
                add(kick(), tb, .35)
            if lv >= 3:
                add(noise(.05, 80, 3), tb, .035, -.4)
        if lv >= 3:
            for k_, n_ in enumerate([80, 78, 76, 78]):
                add(pluck(hz(n_ + 12), 1.2), t + k_ * beat + beat * .75, .045, .2)
        t += bar
        c += 1

    # risers into the drop and the end card; impacts on them and the logo
    for a, b in ((start["drop"] - 3.2, start["drop"]), (start["end"] - 2.2, start["end"])):
        n = int((b - a) * RATE)
        x = np.linspace(0, 1, n)
        fsw = 250 + 1100 * x ** 2
        add(noise(b - a, 0, 2)[:n] * x ** 2.6 * .55 + np.sin(2 * np.pi * np.cumsum(fsw) / RATE) * x ** 3 * .22, a, .3)
    for at_ in (start["logo"] + .05, start["drop"], start["end"]):
        add(kick(), at_, .9)
        add(sub(hz(28), 3.0), at_, .45)
        add(noise(3.0, 1.4, 2), at_, .1)
    add(sum(pad(hz(m), 4.2) for m in (40, 47, 52, 56, 59, 64)), start["end"], .09)
    add(sum(pluck(hz(m), 3.0) for m in (64, 68, 71, 76)), start["end"], .08)

    # ---- effects
    fx = np.zeros((2, total))

    def sfx(sig, at, vol, pan=0.0):
        i = int(at * RATE)
        if i >= total:
            return
        s = sig[:total - i] * vol
        fx[0, i:i + len(s)] += s * math.sqrt((1 - pan) / 2) * 1.4
        fx[1, i:i + len(s)] += s * math.sqrt((1 + pan) / 2) * 1.4

    sfx(whoosh(.7), start["tagline"] - .1, .5, .5)                  # the phone flies in
    for i, t_ in enumerate(phrases("arc")[:5]):
        sfx(blip(hz(76 + [0, 2, 4, 7, 9][i])), start["arc"] + t_ + .1, .22, -.6 + .3 * i)  # chips pop
    sfx(tap(), start["d_sale"] + phrases("d_sale")[1] - .05 + .55 * 1.1, .55)   # the finger presses
    sfx(tap(), start["d_pay"] + dur["d_pay"] - 1.45 + .55 * 1.1, .55)
    sfx(whoosh(.45), start["d_sale"], .35, -.3)
    sfx(blip(hz(93)), start["d_qr"] + 2.2, .2)                      # scanned
    sfx(chime(), start["d_paid"] + .1, .35)                         # paid
    for i in range(3):
        sfx(whoosh(.5), start["devices"] + i * .22, .25, -.5 + .5 * i)  # panels rise
    for i, t_ in enumerate(phrases("benefits")):
        sfx(blip(hz(81 + 2 * i)), start["benefits"] + t_ + .1, .15)
    sfx(whoosh(.6), start["cta"], .3, .4)

    mix = np.stack([L, R])
    d = int(beat * .75 * RATE)
    echo = np.zeros_like(mix)
    echo[0, d:] = mix[1, :-d] * .2
    echo[1, d:] = mix[0, :-d] * .2
    mix = mix + echo
    fade = np.ones(total)
    fade[:int(.6 * RATE)] = np.linspace(0, 1, int(.6 * RATE))
    e = int((total_s - 2.2) * RATE)
    fade[e:] = np.linspace(1, 0, total - e) ** 1.6
    mix = mix * fade / np.max(np.abs(mix)) * .7
    fx = fx / (np.max(np.abs(fx)) + 1e-9) * .5

    def save(arr, name):
        p = OUT / name
        with wave.open(str(p), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes((np.clip(arr.T, -1, 1) * 32767).astype(np.int16).tobytes())
        return p

    music, effects = save(mix, "music.wav"), save(fx, "effects.wav")

    # captions
    def ts(s):
        ms = int(round(s * 1000))
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
    srt, clips = [], []
    for i, (st, dd, name, line, at_, _) in enumerate(rows):
        if not line:
            continue
        vp = voice_path(i)
        clips.append((st + at_, vp))
        srt.append(f"{len(srt) + 1}\n{ts(st + at_)} --> {ts(min(st + at_ + probe(vp) + .3, total_s))}\n{CAPTIONS.get(name, line)}\n")
    (OUT / "vesopa-go-android.srt").write_text("\n".join(srt), encoding="utf-8", newline="\n")

    film = OUT / "picture.mp4"
    final = OUT / "vesopa-go-android.mp4"
    args = ["ffmpeg", "-y", "-v", "error", "-i", str(film), "-i", str(music), "-i", str(effects)]
    for _, vp in clips:
        args += ["-i", str(vp)]
    parts, labels = [], []
    for i, (t0, _) in enumerate(clips):
        ms = int(t0 * 1000)
        parts.append(f"[{i + 3}:a]aresample={RATE},aformat=channel_layouts=stereo,adelay={ms}|{ms},volume=1.6[v{i}]")
        labels.append(f"[v{i}]")
    parts.append(f"{''.join(labels)}amix=inputs={len(clips)}:normalize=0,highpass=f=80,"
                 "equalizer=f=180:t=q:w=1:g=1.5,equalizer=f=3200:t=q:w=1.2:g=2.5,equalizer=f=9000:t=q:w=1:g=1.5,"
                 "acompressor=threshold=0.08:ratio=3:attack=4:release=140:makeup=1.5,"
                 "aecho=0.8:0.5:28|47:0.10|0.06[vo]")
    parts.append(f"[1:a]aresample={RATE},volume=.55[bed]")
    parts.append("[vo]asplit=2[vo1][vo2]")
    parts.append("[bed][vo2]sidechaincompress=threshold=0.03:ratio=5:attack=30:release=450[ducked]")
    parts.append(f"[2:a]aresample={RATE},volume=.8[fx]")
    parts.append("[ducked][fx][vo1]amix=inputs=3:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=9[a]")
    args += ["-filter_complex", ";".join(parts), "-map", "0:v", "-map", "[a]", "-c:v", "copy",
             "-c:a", "aac", "-b:a", "192k", "-ar", str(RATE), "-t", f"{probe(film):.3f}", str(final)]
    subprocess.run(args, check=True)
    print(final.relative_to(GO), f"{probe(final):.1f}s")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("voice", "all"):
        make_voice()
    if what in ("film", "all"):
        make_film()
    if what in ("audio", "all"):
        make_audio()
