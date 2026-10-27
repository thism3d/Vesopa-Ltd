# Vesopa EPOS: 30-second velocity edit

`Vesopa_EPOS_Velocity_30s.mp4`: 1080x1920, 30 fps, 30 s, H.264 + AAC. Made for TikTok, Reels and Shorts.

It follows the structure of the reference edit (@harveyangelada, the American Ribs & Wings promo): a
cinematic establishing shot, a speed-ramped push into a logo slam, then a pop-art comic section with
halftone, ink outlines and speech bubbles, big slam headlines that land on the beat, a comic-panel
montage and a storefront outro.

| Time | Shot | Footage |
|---|---|---|
| 0.0 to 2.0 | "STILL ON AN OLD TILL?" | `st1_problem` |
| 2.0 to 3.5 | Comic chaos: UGH! / WHERE'S TABLE 6?! / LOST AGAIN! | `st4_iteration` (comic) |
| 3.5 to 4.0 | Zoom-blur rush, white flash | `st5_wider` |
| 4.0 to 6.0 | Logo slam on the drop: VESOPA EPOS | vector logo |
| 6.0 to 9.0 | ORDERS IN SECONDS, with taps on the real till | `Vesopa_EPOS_Home.png` |
| 9.0 to 11.0 | CARD. CASH. SPLIT. PAID. | `Vesopa_EPOS_Payment_Screen.png` |
| 11.0 to 13.0 | BEEP! / PAID IN 2 SECONDS! | `v1_hero` (comic) |
| 13.0 to 15.5 | ORDER UP! then STRAIGHT TO THE KITCHEN | `v3_pass` (comic) + `Vespa_Kitchen_Home.png` |
| 15.5 to 18.0 | LOYALTY BUILT IN, with the loyalty card as a sticker | `m2_loyalty` (comic) + `loyalty_1` |
| 18.0 to 20.5 | SELF-ORDER KIOSKS / NO QUEUE! | `m3_kiosk` (comic) + `express_2` |
| 20.5 to 22.5 | ORDER AT THE TABLE (Vesopa Tap) | `m1_menu` |
| 22.5 to 25.0 | CLOUD BACK OFFICE / REPORTS FROM ANYWHERE | `v5_aisle`, `e3_cloud_day` |
| 25.0 to 27.0 | Comic-panel montage: ONE SYSTEM! | comic frames |
| 27.0 to 30.0 | Outro: logo, vesopaepos.com, +44 1792 316282 | `e2_venue` |

The footage and screenshots come from `vesopasoftware/site/assets/`. The soundtrack is synthesised by
`tools/music.py` (120 BPM, A minor). It is royalty-free, and every whoosh, tap click, card beep and
impact is timed to the picture.

## Rebuild

```bash
B=/some/scratch/build            # working folder, not committed: about 2,000 extracted frames
mkdir -p $B/frames $B/src && cp -r build/render.html build/fonts $B/
for c in st1_problem st4_iteration st5_wider e2_venue v1_hero v3_pass m2_loyalty m3_kiosk m1_menu v5_aisle e3_cloud_day; do
  mkdir -p $B/frames/$c && ffmpeg -i ../../vesopasoftware/site/assets/video/$c.mp4 -vf fps=30 -q:v 2 $B/frames/$c/%04d.jpg
done
A=../../vesopasoftware/site/assets/screenshots
cp $A/Vesopa_EPOS_Home.png $A/Vesopa_EPOS_Payment_Screen.png $A/Vespa_Kitchen_Home.png $B/src/
ffmpeg -i $A/express_2.webp $B/src/express_2.png; ffmpeg -i $A/loyalty_1.webp $B/src/loyalty_1.png
python3 tools/comic.py $B/frames st4_iteration v1_hero v3_pass m2_loyalty m3_kiosk   # pop-art versions
python3 tools/music.py $B/music.wav
node tools/drive.js $B preview $B/prev 150 300 600                                   # check stills
node tools/drive.js $B video out.mp4 $B/music.wav                                    # full render, about 2.5 min
```

`drive.js` needs Playwright with Chromium. `comic.py` needs numpy and Pillow. Inter Bold and Inter
SemiBold come from the system (`/usr/share/fonts/opentype/inter/`); copy them into `fonts/` as well.
Scene timings, words and camera moves are all in the `SCENES` list in `build/render.html`.

---

# Version 2: matched to the reference's beat (use this one)

The reference sound runs at 80 BPM, with a velocity burst every 0.75 s starting at 0.45 s (I measured
it frame by frame off the TikTok player). Version 2 puts every cut and burst on that grid, so the
creator's sound ("original sound - harveyverse") lines up when it is added in TikTok.

| File | Use |
|---|---|
| `Vesopa_EPOS_TikTok_NoSound.mp4` | TikTok: add the reference sound in the app (steps below) |
| `Vesopa_EPOS_Reels_WithMusic.mp4` | Instagram Reels and YouTube Shorts: our own 80 BPM track on the same grid |

## Adding the exact sound on TikTok

1. Open the reference video on your phone. Tap the spinning record at the bottom right
   ("original sound - harveyverse"), then tap **Use this sound**.
2. Tap **Upload** and pick `Vesopa_EPOS_TikTok_NoSound.mp4`.
3. Leave the sound starting at 0:00; don't trim its start. The cuts are timed to it from the first frame.
4. If TikTok also offers "Original sound" for the clip, turn it to 0 (the file is silent anyway).

If the sound will not attach (the creator can turn reuse off), use any trending 80 or 160 BPM sound
instead. The edit lands on the beat with those too.

## What changed from version 1

- Bright, warm grade on the real footage, and a blue-and-yellow pop-art grade for the comic section
  (`POP=1 python3 tools/comic.py ...` writes `<clip>_pop` frames).
- The real Vesopa till screen is pinned onto the blank screen in the pub footage (`pinScreen`).
- The logo is on the venue wall with three camera angles, and the shot flickers from real to comic at
  8.85 s, like the reference's style flicker. There is a second real-to-comic flicker at 22.95 s.
- Hero shots work like the reference's food shots: the till, payment and kitchen screens sit on a
  smoky, ember-lit stage with glowing angled headlines and jump to a new angle on each beat.
- Renderer: `build/render2.html` (shot list `SHOTS`). Music: `tools/music_v2.py`.
  `PAGE=render2.html node tools/drive.js <build> video out.mp4 music_v2.wav`.
