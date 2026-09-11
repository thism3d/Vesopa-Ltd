"""
The Microsoft Store's pictures of Vesopa Express, drawn from the mark itself.

    python tool/make_store_art.py <out-dir>

THE FAMILY THIS BELONGS TO

Each Vesopa app's Store tiles are its own colourway of the one V, and its
poster is that tile with the product's name under it:

    Vesopa Kitchen   black ground, lime V, white wedge, "KITCHEN" in lime
    Vesopa Display   lime ground,  white V, black wedge, "DISPLAY" in white
    Vesopa Express   paper ground, ink V,  lime wedge + speed lines, "EXPRESS" in ink

Express's colourway is the app's own icon (see make_icons.py, whose geometry
this imports rather than redraws): the light one, because it is the one screen
of the family a member of the public touches.

WHAT IT WRITES (the sizes Partner Center asks for, and the other apps use)

    store_icon_300.png          1:1 app tile icon            -> Icon
    store_box_art_2160.png      1:1 box art                  -> StoreLogoSquare
    store_poster_1440x2160.png  2:3 poster art               -> StoreLogo9x16

The 16:9 hero is not drawn here: it shows the kiosk itself (make_store_hero.py).
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_icons import INK, LIME, PAPER, render  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
FONT = HERE / "assets" / "fonts" / "Montserrat-ExtraBold.ttf"


def poster(width=1440, height=2160):
    """The tile on a tall ground, with EXPRESS under the mark."""
    img = Image.new("RGB", (width, height), PAPER)
    # The mark, transparent, at the width the Kitchen's and Display's V take on
    # their posters (about four fifths of the ground).
    mark = render(1600, full_bleed=False)
    box = mark.getbbox()
    mark = mark.crop(box)
    target_w = int(width * 0.80)
    mark = mark.resize((target_w, int(mark.height * target_w / mark.width)), Image.LANCZOS)
    top = int(height * 0.25)
    img.paste(mark, ((width - mark.width) // 2, top), mark)

    d = ImageDraw.Draw(img)
    word = "EXPRESS"
    size = 300
    font = ImageFont.truetype(str(FONT), size)
    # As wide as the Kitchen's KITCHEN sits on its poster: two thirds.
    while d.textlength(word, font=font) > width * 0.70:
        size -= 4
        font = ImageFont.truetype(str(FONT), size)
    w = d.textlength(word, font=font)
    y = top + mark.height + int(height * 0.075)
    d.text(((width - w) / 2, y), word, font=font, fill=INK)
    return img


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "build" / "store-art"
    out.mkdir(parents=True, exist_ok=True)
    # Fuller than the app icon, as the Kitchen's and the Display's Store tiles
    # are: a Store tile is seen small, beside other people's logos.
    render(300, fill=0.78).convert("RGB").save(out / "store_icon_300.png")
    render(2160, fill=0.78).convert("RGB").save(out / "store_box_art_2160.png")
    poster().save(out / "store_poster_1440x2160.png")
    for p in sorted(out.glob("store_*.png")):
        with Image.open(p) as im:
            print(f"{p.name:32} {im.size[0]}x{im.size[1]}")


if __name__ == "__main__":
    main()
