# Vesopa — the four cinematic clips
### 4 × MiniMax Hailuo, Cinematic, 6 seconds. Paste these exactly.

---

## Before you start: two things that decide whether these work

**1. Upload the start frame every time.** Do not use text-to-video. Hailuo will
invent a different room, different hardware, and — reliably — text on a screen
that we spent the whole image pass keeping blank. I've generated all four start
frames; they're listed below. The frame goes in the image slot, the text below
goes in "Describe what video you want to create".

**2. Hailuo reads bracketed camera directives literally.** `[Push in]`,
`[Static shot]` and so on are a real instruction set, not decoration. They are
the single biggest lever you have on this tool, and they're why all four shots
below open with one. Use exactly one directive per clip — stacking them makes
the move mushy.

Since everything is now on one tool, a note on where Hailuo is weak: it drifts
on long constant camera moves. Clip 1 is the shot most at risk, so it's written
to give the model as little room to wander as possible, and it's the one worth
regenerating if you have a spare credit.

---

## Clip 1 · The Cloud aisle
*Section 05. The most important clip on the site — do this one first.*

**Start frame:** `site/assets/video/v5_aisle.png`
**Settings:** Cinematic · 6s · image-to-video

**Describe what video you want to create:**
```
[Push in] The camera moves straight forward down the centre of the aisle at one constant speed for the entire six seconds. The vanishing point stays exactly in the centre of the frame. Hundreds of small status LEDs blink out of sync on both walls of racks. The green floor strip stays straight. No acceleration, no slowing down, no turning, no tilting, no rotation.
```
**Negative:**
```
people, person, technician, worker, hands, text, letters, numbers, watermark, logo, signage, camera acceleration, camera turning, banking, tilting, rotation, doors opening, fog, haze, blue lighting, purple lighting, neon cyberpunk, hologram UI, lens flare, cut, scene change
```

---

## Clip 2 · The tap
*Section 01, hero. A hand and a card.*

**Start frame:** `site/assets/video/v1_hero.png`
**Settings:** Cinematic · 6s · image-to-video

**Describe what video you want to create:**
```
[Push in] The hand lowers the card flat onto the contactless reader over the first three seconds. The green ring pulses once brightly, then settles and stays dim. The camera pushes in about ten centimetres across the full six seconds at one constant speed. The hand stays in frame and does not withdraw. Nothing else moves.
```
**Negative:**
```
text, letters, numbers, watermark, logo, brand marks, signage, extra fingers, sixth finger, deformed hands, melting fingers, plastic skin, second hand entering frame, card flipping, card falling, oversaturated, HDR halo, lens flare, fisheye, vignette, neon cyberpunk, hologram UI, blue tech grid, camera shake, fast motion, cut, scene change
```

---

## Clip 3 · The pass
*Section 01 support. Locked-off camera plus one hand — Hailuo's best case.*

**Start frame:** `site/assets/video/v3_pass.png`
**Settings:** Cinematic · 6s · image-to-video

**Describe what video you want to create:**
```
[Static shot] The printer feeds the blank white ticket further forward over the first four seconds while steam keeps drifting upward through the frame. At about four and a half seconds a single hand enters from the right and tears the ticket away in one clean motion, then leaves the frame. The camera does not move at all for the entire six seconds.
```
**Negative:**
```
text, letters, numbers, printed characters on the paper, receipt printing, watermark, logo, signage, paper jam, crumpling, tearing into pieces, multiple hands, two hands, extra fingers, deformed hands, oversaturated, lens flare, fisheye, vignette, camera movement, zoom, pan, push in, cut, scene change
```

---

## Clip 4 · Settlement
*Section 06. No hands, no camera discipline needed — pure material.*

**Start frame:** `site/assets/video/v6_settle.png`
**Settings:** Cinematic · 6s · image-to-video

**Describe what video you want to create:**
```
[Static shot] The pool of dark liquid metal draws itself slowly upward and solidifies into a thick machined disc over the full six seconds. A single arc of warm amber light crosses its surface once as it sets, then vanishes. The motion is continuous and extremely slow throughout. No splash, no droplets, no ripples leaving the frame, no bouncing.
```
**Negative:**
```
text, letters, numbers, currency symbols, bitcoin symbol, dollar sign, coins, gold, treasure, sparkle, glitter, watermark, logo, splash, droplets, spray, bubbling, boiling, fast motion, camera shake, camera movement, oversaturated, lens flare, cut, scene change
```

---

## What to do with the files

Name them exactly this, in `site/assets/video/`:

```
v5_aisle.mp4      v1_hero.mp4      v3_pass.mp4      v6_settle.mp4
```

The page already has all four wells wired. Each shows its start frame as a
poster and swaps the clip in when the file exists — nothing breaks while they're
missing and nothing needs editing when they land. Drop them in and reload.

**Export:** MP4 H.264, 1440×810 is plenty. The wells are max 46rem wide and the
whole-page budget is 6 MB, so a 4K master will blow it on its own. If Hailuo
only gives you one size, keep it and I'll transcode.

**6s vs the 5s the pack assumed:** fine, and slightly better. The clips loop
under a scroll-driven section rather than playing to a timed edit, so a longer
clip just means a longer gap before the loop point shows. No other change needed.

---

## Motion you do NOT need to spend credits on

Three things already move, and they're the ones carrying the page:

- **The particle field** — 32,768 points at 60fps, morphing through seven
  targets across the whole scroll. This is the site's main motion. Shader code.
- **The ink→paper inversion** at Cloud, driven off scroll position.
- **The morph targets themselves** — till, rack and token now sample the
  generated mattes and depth maps, so they're real geometry rather than
  stand-ins.

The four clips are texture. If two come back bad, the site still works.
