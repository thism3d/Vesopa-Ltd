"""go.vesopa.com's pictures and films, from the store screenshots and from
frames of the app's own payment screen.

    python vesopa_go/tool/make_site_media.py [FRAMES_DIR]

  * img/shots/*.webp   the store screenshots (store/screenshots), smaller
  * img/qr-ios.svg, img/qr-android.svg   the two test links as QR codes
  * img/og.jpg         the link picture (1200 x 630)
  * media/*.mp4 + .webp poster   films, when FRAMES_DIR holds iphone-paid/,
    ipad-paid/ and iphone-declined/ (PNG frames at 30 a second, drawn by a
    scratch widget test of counter/ui/card_pay_screen.dart)

Needs Pillow, qrcode and imageio-ffmpeg.
"""
import subprocess
import sys
from pathlib import Path

import qrcode
import qrcode.image.svg
from PIL import Image, ImageDraw, ImageFilter, ImageFont

GO = Path(__file__).resolve().parents[1]
SITE = GO / "web" / "site"
SHOTS = GO / "store" / "screenshots"
IOS = "https://testflight.apple.com/join/zgg5YSn8"
ANDROID = "https://play.google.com/apps/testing/com.vesopa.go"


def shots():
    out = SITE / "img" / "shots"
    out.mkdir(parents=True, exist_ok=True)
    for folder, prefix, width in (("ipad-13", "ipad", 1600), ("iphone-6.9", "iphone", 760), ("android-phone", "android", 620)):
        for p in sorted((SHOTS / folder).glob("0*.png")):
            im = Image.open(p).convert("RGB")
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
            im.save(out / f"{prefix}-{p.stem}.webp", quality=84, method=6)


def qrs():
    for name, url in (("qr-ios", IOS), ("qr-android", ANDROID)):
        img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, border=1, box_size=10)
        img.save(str(SITE / "img" / f"{name}.svg"))


def font(size, bold=True):
    for f in ("C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def device(shot, radius, border=10):
    im = Image.open(shot).convert("RGB")
    w, h = im.size
    framed = Image.new("RGBA", (w + border * 2, h + border * 2), (0, 0, 0, 0))
    ImageDraw.Draw(framed).rounded_rectangle((0, 0, w + border * 2 - 1, h + border * 2 - 1), radius + border, fill=(24, 27, 22, 255))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius, fill=255)
    framed.paste(im, (border, border), mask)
    return framed


def og():
    W, H = 1200, 630
    bg = Image.new("RGB", (W, H), (11, 13, 10))
    glow = Image.new("RGB", (W, H), (11, 13, 10))
    ImageDraw.Draw(glow).ellipse((620, 60, 1260, 700), fill=(70, 88, 10))
    bg = Image.blend(bg, glow.filter(ImageFilter.GaussianBlur(120)), 0.9)
    pad = device(SITE / "img" / "shots" / "ipad-01-sale.webp", 26)
    pad = pad.resize((540, round(pad.height * 540 / pad.width)))
    phone = device(SITE / "img" / "shots" / "iphone-05-approved.webp", 60, 14)
    phone = phone.resize((180, round(phone.height * 180 / phone.width)))
    bg.paste(pad, (640, 150), pad)
    bg.paste(phone, (590, 215), phone)
    d = ImageDraw.Draw(bg)
    d.text((64, 70), "VESOPA GO", font=font(28), fill=(165, 199, 21))
    d.text((64, 130), "The till,", font=font(78), fill=(242, 244, 236))
    d.text((64, 220), "in your hand.", font=font(78), fill=(165, 199, 21))
    d.text((64, 340), "Tables, the kitchen, Tap to Pay on iPhone,\nQR Pay and card machines.", font=font(27, False), fill=(163, 167, 154), spacing=10)
    d.text((64, 520), "go.vesopa.com", font=font(26), fill=(242, 244, 236))
    bg.save(SITE / "img" / "og.jpg", quality=88)
    # The hero's stand-in without WebGL: the two devices on their own.
    still = Image.new("RGBA", (1100, 900), (0, 0, 0, 0))
    big = device(SITE / "img" / "shots" / "ipad-01-sale.webp", 30)
    big = big.resize((900, round(big.height * 900 / big.width)))
    ph = device(SITE / "img" / "shots" / "iphone-02-pay.webp", 60, 14)
    ph = ph.resize((300, round(ph.height * 300 / ph.width)))
    still.paste(big, (180, 120), big)
    still.paste(ph, (40, 260), ph)
    still.convert("RGB").save(SITE / "img" / "hero-still.jpg", quality=86)


def films(frames):
    import imageio_ffmpeg
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    media = SITE / "media"
    media.mkdir(exist_ok=True)
    for clip, name, width in (("iphone-paid", "pay-iphone", 540), ("ipad-paid", "pay-ipad", 1180), ("iphone-declined", "declined-iphone", 540)):
        src = frames / clip
        if not src.is_dir():
            print(f"  no frames for {clip}")
            continue
        subprocess.run([ff, "-y", "-loglevel", "error", "-framerate", "30", "-i", str(src / "f%04d.png"),
                        "-vf", f"scale={width}:-2:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow",
                        "-crf", "24", "-movflags", "+faststart", "-an", str(media / f"{name}.mp4")], check=True)
        # The poster: the moment the card is on the reader (or the result).
        pick = sorted(src.glob("f*.png"))
        poster = pick[min(len(pick) - 1, 100 if "paid" in clip else len(pick) - 10)]
        im = Image.open(poster).convert("RGB")
        im.resize((width, round(im.height * width / im.width)), Image.LANCZOS).save(media / f"{name}.webp", quality=80)
        print(f"  {name}.mp4 {(media / f'{name}.mp4').stat().st_size // 1024} KB")


if __name__ == "__main__":
    shots()
    qrs()
    og()
    if len(sys.argv) > 1:
        films(Path(sys.argv[1]))
    print("done")
