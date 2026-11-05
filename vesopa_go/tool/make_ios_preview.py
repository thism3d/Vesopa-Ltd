"""Vesopa Go App Preview for the iPhone App Store page (2026-11-05): the video
Apple shows beside the iPhone screenshots.

Apple's rules: 15 to 30 seconds, the iPhone 6.9-inch preview size (886x1920
portrait), 30 fps H.264, stereo AAC, and mostly the app's own screens. So this
is the store pictures in motion, not the promo film: the lime ground and the
headline of each picture, the real iPhone screen under it (no device), a tap
on Pay and on QR Pay, each screen sliding in as the app does, the voice of the
Android film (Kokoro, read a phrase at a time) and a short score.

    python tool/make_ios_preview.py           # voice, picture, sound
    STILLS=2,12 python tool/make_ios_preview.py picture

Writes store/previews/iphone-6.9/01-preview.mp4 (app_store_connect.py store
uploads it) and its working files under store/marketing/video/ios-preview/.
"""
import math
import os
import pathlib
import subprocess
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw

GO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GO / "tool"))
import make_android_film as A  # noqa: E402  voice, sound helpers
from make_store_video import ease, put  # noqa: E402

S, P = A.S, A.P
W, H, FPS = 886, 1920, 30
WORK = GO / "store" / "marketing" / "video" / "ios-preview"
FINAL = GO / "store" / "previews" / "iphone-6.9" / "01-preview.mp4"
BARS = (.085, .05)  # the iPhone pictures' status and home bars

# (screen, headline, phrases, the tap that leads to the next screen in
# screenshot pixels, status bar included, or None)
SCENES = [
    ("01-sale", "Orders *anywhere* on the floor",
     [("Meet Vesopa Go.", A.P_MID), ("Your whole till,", A.P_SHORT), ("right in your pocket.", 0)], (1114, 2493)),
    ("02-pay", "Every way to *pay*", [("Cash. Card. Tap to Pay. Or QR.", 0)], (1055, 1289)),
    ("03-qr-pay", "*QR Pay* at the table", [("Guests scan,", A.P_SHORT), ("pay,", A.P_SHORT), ("and go.", 0)], None),
    ("04-check", "The whole bill at a *glance*", [("Every item. Every server. Live.", 0)], None),
    ("05-approved", "Paid. *Done.*", [("Paid!", A.P_MID), ("Print or email the receipt, in one tap.", 0)], None),
    ("end", None, [("Vesopa Go.", A.P_MID), ("Orders and payments, anywhere.", 0)], None),
]
LEAD, TAIL, SLIDE = .45, .55, .35


def voice_file(i):
    return WORK / f"line_{i}.wav"


def make_voice():
    from kokoro_onnx import Kokoro
    k = Kokoro(str(A.KOKORO / "kokoro-v1.0.onnx"), str(A.KOKORO / "voices-v1.0.bin"))
    WORK.mkdir(parents=True, exist_ok=True)
    for i, (_, _, phr, _) in enumerate(SCENES):
        parts = []
        for text, pause in phr:
            sig, sr = k.create(text, voice=A.VOICE, speed=.95, lang="en-gb")
            sig = np.asarray(sig, dtype=np.float32)
            on = np.nonzero(np.abs(sig) > .012)[0]
            sig = sig[max(0, on[0] - 300):on[-1] + 1400]
            parts += [sig, np.zeros(int(pause * sr), dtype=np.float32)]
        y = np.concatenate(parts)
        y = y / np.max(np.abs(y)) * .89
        with wave.open(str(voice_file(i)), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((y * 32767).astype(np.int16).tobytes())


def timeline():
    """[(start, dur)] per scene: the lead-in, the line, a breath; the taps get
    a moment more."""
    rows, t = [], 0.0
    for i, (_, _, _, tap) in enumerate(SCENES):
        d = LEAD + A.probe(voice_file(i)) + TAIL + (.7 if tap else 0)
        rows.append((t, d))
        t += d
    return rows


def screen_card(shot, width=640):
    path = S.screen_file("iphone-6.9", shot, False, BARS)
    im = Image.open(path).convert("RGBA")
    h = int(width * im.height / im.width)
    im = im.resize((width, h), Image.LANCZOS)
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, h - 1), 46, fill=255)
    card = Image.new("RGBA", (width + 120, h + 140), (0, 0, 0, 0))
    shadow = Image.new("RGBA", card.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((60, 80, 60 + width, 80 + h), 46, fill=(40, 50, 0, 120))
    from PIL import ImageFilter
    card.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(28)))
    card.paste(im, (60, 50), mask)
    return card, width / Image.open(path).width


def make_picture():
    WORK.mkdir(parents=True, exist_ok=True)
    k = W / 1080
    bg = S.R._shoot(A.V.html(f"""<div style="position:relative;width:{W}px;height:{H}px;overflow:hidden;
      background:linear-gradient(180deg,#B4D31E 0%,{S.LIME} 55%,#98B813 100%)">
      <div style="position:absolute;left:-300px;top:-200px;width:1100px;height:1100px;border-radius:50%;background:rgba(255,255,255,.13)"></div>
      <div style="position:absolute;left:200px;top:1000px;width:1200px;height:1200px;border-radius:50%;background:rgba(255,255,255,.08)"></div>
      </div>"""), W, H).convert("RGBA")
    heads = {}
    for shot, title, _, _ in SCENES:
        if title:
            im = S.R._shoot(A.V.html(f'<div style="width:{W - 80}px;font-family:Mont"><h1 style="margin:0;font-size:{78 * k * 1.12:.0f}px">'
                                     f'{S.headline(title)}</h1></div>'), W, 400)
            heads[shot] = im.crop(im.getbbox())
    cards = {shot: screen_card(shot) for shot, title, _, _ in SCENES if title}
    end = A.V.logo_layer("Orders &amp; payments, anywhere")
    end = end.resize((int(end.width * .62), int(end.height * .62)), Image.LANCZOS)
    rows = timeline()
    total = rows[-1][0] + rows[-1][1]
    assert 15 <= total <= 30, f"Apple takes 15 to 30 seconds; this is {total:.1f}"
    top = 400

    def scene(i, u, d, f):
        shot, title, _, tap = SCENES[i]
        if not title:
            kk = ease(u / .7)
            put(f, end, W / 2 - end.width / 2, H / 2 - end.height / 2 + (1 - kk) * 40, alpha=kk, scale=.9 + .1 * kk)
            return
        card, sc = cards[shot]
        kin = ease(u / SLIDE) if i else ease(u / .6)
        x = W / 2 - card.width / 2 + (1 - kin) * (W if i else 0)
        y = top + math.sin(u * 1.1) * 4 + ((1 - kin) * 120 if i == 0 else 0)
        put(f, card, x, y, alpha=1 if i else kin)
        hd = heads[shot]
        kh = ease((u - .1) / .5)
        put(f, hd, W / 2 - hd.width / 2, 150 - hd.height / 2 + 80 + (1 - kh) * 30, alpha=kh)
        if tap:
            A.V.ripple(f, x + 60 + tap[0] * sc, y + 50 + tap[1] * sc, (u - (d - .95)) / .6)

    def at(t):
        i = next(j for j, (st, d) in enumerate(rows) if t < st + d or j == len(rows) - 1)
        st, d = rows[i]
        f = bg.copy()
        u = t - st
        if i and SCENES[i][1] and u < SLIDE:  # the screen before slides out to the left
            pst, pd = rows[i - 1]
            ps = SCENES[i - 1][0]
            card, _ = cards[ps]
            put(f, card, W / 2 - card.width / 2 - ease(u / SLIDE) * W, top, alpha=1)
        scene(i, u, d, f)
        if i + 1 < len(rows) and not SCENES[i + 1][1] and t > st + d - .35:  # into the end card
            g = bg.copy()
            scene(i + 1, 0.0, rows[i + 1][1], g)
            f = Image.blend(f, g, ease((t - (st + d - .35)) / .35))
        return f

    stills = [float(s) for s in os.environ.get("STILLS", "").split(",") if s]
    if stills:
        for t in stills:
            at(t).convert("RGB").save(WORK / f"still_{t:04.1f}.png")
        return None
    out = WORK / "picture.mp4"
    n = int(total * FPS)
    ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                           "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-profile:v", "high", "-level", "4.0",
                           "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart", str(out)], stdin=subprocess.PIPE)
    for j in range(n):
        ff.stdin.write(at(j / FPS).convert("RGB").tobytes())
    ff.stdin.close()
    ff.wait()
    print(f"picture {total:.1f}s")
    return rows


def make_sound(rows):
    RATE = A.RATE
    total_s = rows[-1][0] + rows[-1][1]
    n = int((total_s + .5) * RATE)
    L, R = np.zeros(n), np.zeros(n)

    def add(sig, at, vol, pan=0.0, fx=False):
        i = int(at * RATE)
        if i >= n:
            return
        s = sig[:n - i] * vol
        L[i:i + len(s)] += s * math.sqrt((1 - pan) / 2) * 1.4
        R[i:i + len(s)] += s * math.sqrt((1 + pan) / 2) * 1.4

    beat = 60 / 112
    bar = beat * 4
    prog = [(49, [61, 64, 68, 73]), (45, [61, 64, 69, 73]), (40, [59, 64, 68, 71]), (47, [59, 63, 66, 71])]
    end_at = rows[-1][0]
    t, c = 0.0, 0
    while t < end_at:
        root, ch = prog[c % 4]
        add(sum(A.pad(A.hz(m), bar + 1.2) for m in ch), t, .055)
        for e in range(8):
            te = t + e * beat / 2
            if te < end_at:
                add(A.pluck(A.hz(ch[[0, 2, 1, 3, 2, 1, 3, 2][e]] + 12)), te, .09 if e % 2 == 0 else .065, .35 if e % 2 else -.35)
        for b in (0, 1.5, 2, 3.5):
            if t + b * beat < end_at:
                add(A.sub(A.hz(root - 12), beat * 1.2), t + b * beat, .22)
        if t >= bar:  # the beat comes in after the first bar
            for b in range(4):
                tb = t + b * beat
                if tb < end_at:
                    add(A.kick(), tb, .4)
                    if b % 2:
                        add(A.noise(.2, 16, 1), tb, .12, .1)
                    add(A.noise(.05, 80, 3), tb + beat / 2, .04, .4)
        t += bar
        c += 1
    add(A.kick(), end_at, .8)
    add(A.sub(A.hz(28), 2.5), end_at, .4)
    add(sum(A.pad(A.hz(m), 3.5) for m in (40, 47, 52, 56, 59, 64)), end_at, .09)
    add(sum(A.pluck(A.hz(m), 3.0) for m in (64, 68, 71, 76)), end_at, .08)
    mix = np.stack([L, R])
    fade = np.ones(n)
    fade[:int(.4 * RATE)] = np.linspace(0, 1, int(.4 * RATE))
    e = int((total_s - 1.6) * RATE)
    fade[e:] = np.linspace(1, 0, n - e) ** 1.6
    mix = mix * fade / np.max(np.abs(mix)) * .7

    fx = np.zeros((2, n))

    def sfx(sig, at, vol):
        i = int(at * RATE)
        s = sig[:n - i] * vol
        fx[:, i:i + len(s)] += s
    for i, (st, d) in enumerate(rows):
        if SCENES[i][3]:
            sfx(A.tap(), st + d - .95 + .1, .5)
        if i and SCENES[i][1]:
            sfx(A.whoosh(.4), st - .05, .25)
    sfx(A.chime(), rows[4][0] + .15, .35)
    fx = fx / (np.max(np.abs(fx)) + 1e-9) * .5

    def save(arr, name):
        p = WORK / name
        with wave.open(str(p), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes((np.clip(arr.T, -1, 1) * 32767).astype(np.int16).tobytes())
        return p
    music, effects = save(mix, "music.wav"), save(fx, "effects.wav")

    FINAL.parent.mkdir(parents=True, exist_ok=True)
    args = ["ffmpeg", "-y", "-v", "error", "-i", str(WORK / "picture.mp4"), "-i", str(music), "-i", str(effects)]
    parts, labels = [], []
    for i, (st, _) in enumerate(rows):
        args += ["-i", str(voice_file(i))]
        ms = int((st + LEAD) * 1000)
        parts.append(f"[{i + 3}:a]aresample={RATE},aformat=channel_layouts=stereo,adelay={ms}|{ms},volume=1.6[v{i}]")
        labels.append(f"[v{i}]")
    parts.append(f"{''.join(labels)}amix=inputs={len(rows)}:normalize=0,highpass=f=80,"
                 "equalizer=f=180:t=q:w=1:g=1.5,equalizer=f=3200:t=q:w=1.2:g=2.5,equalizer=f=9000:t=q:w=1:g=1.5,"
                 "acompressor=threshold=0.08:ratio=3:attack=4:release=140:makeup=1.5,aecho=0.8:0.5:28|47:0.10|0.06[vo]")
    parts += [f"[1:a]aresample={RATE},volume=.55[bed]", "[vo]asplit=2[vo1][vo2]",
              "[bed][vo2]sidechaincompress=threshold=0.03:ratio=5:attack=30:release=450[ducked]",
              f"[2:a]aresample={RATE},volume=.8[fx]",
              "[ducked][fx][vo1]amix=inputs=3:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=9[a]"]
    args += ["-filter_complex", ";".join(parts), "-map", "0:v", "-map", "[a]", "-c:v", "copy",
             "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", "-t", f"{total_s:.3f}", str(FINAL)]
    subprocess.run(args, check=True)
    print(FINAL.relative_to(GO), f"{A.probe(FINAL):.1f}s")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what == "all":
        make_voice()
    if what in ("picture", "all"):
        rows = make_picture()
        if rows and what == "all":
            make_sound(rows)
