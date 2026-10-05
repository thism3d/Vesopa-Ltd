"""Frames from tool/make-invite-art.js -> the email's pictures.

    python tool/invite/make_gif.py <out-dir>

Writes metric-hero.gif (600 x 280, looping), backoffice-memberships.png (the
Memberships page without the menu rail) and metric-app.jpg next to this file.
Needs Pillow.
"""
import pathlib
import sys

from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "invite-art")

frames = sorted((src / "frames").glob("*.png"))
small = [Image.open(f).convert("RGB").resize((600, 280), Image.LANCZOS) for f in frames]
# One palette for every frame keeps the colours steady and the file small.
palette = small[len(small) // 2].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
gif = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in small]
n = len(gif)
durations = []
for i in range(n):
    t = i / n
    if 0.46 <= t < 0.5:
        durations.append(260)   # linger on "Member · let in"
    elif i == 0:
        durations.append(500)
    else:
        durations.append(70)
gif[0].save(HERE / "metric-hero.gif", save_all=True, append_images=gif[1:], duration=durations, loop=0,
            optimize=True, disposal=1)

bo = Image.open(src / "memberships.png").convert("RGB").crop((236, 0, 1425, 900))
bo.resize((1100, int(900 * 1100 / 1189)), Image.LANCZOS).save(HERE / "backoffice-memberships.png", optimize=True)

app = Image.open(ROOT / "MetricMembership" / "store" / "screenshots" / "01 Your car is your pass.png").convert("RGB")
app.resize((1100, int(app.height * 1100 / app.width)), Image.LANCZOS).save(HERE / "metric-app.jpg", quality=86, optimize=True)

for f in ["metric-hero.gif", "backoffice-memberships.png", "metric-app.jpg"]:
    print(f, (HERE / f).stat().st_size // 1024, "KB")
