# Vesopa — the remaining nine clips

### 9 × image-to-video, 6 seconds. Every start frame already exists. Paste exactly.

The four cinematic clips (V1 tap, V3 pass, V5 aisle, V6 settlement) are in and
working. These nine animate the images **already on the page** — the section
plates and the six story frames. Nothing here needs a new image generated.

---

## The three rules, again

**1. Upload the start frame. Never text-to-video.** Every frame is listed with
its path. Use the PNG from `masters/`, not the `.webp` from `site/` — the webp
is a compressed derivative and the model will chew on its artefacts.

**2. One bracketed directive per clip.** `[Static shot]`, `[Push in]`,
`[Pedestal up]`. Hailuo reads these literally; Luma respects them loosely.
Stacking two makes the move mushy.

**3. These are texture, not story.** Eight of the nine sit in small figures on
the page — the story frames render about 26rem wide. Nobody is studying them.
Subtle beats spectacular, and a clip that drifts is worse than a still.

**Which tool:** Hailuo for anything with a person or a hand in it (better
anatomy), Luma Ray 2 for the still-life and landscape shots (better slow drift).
Marked per clip.

---

# Group 1 — the section plates (3 clips)

## C1 · The venue
*Section 01. Busy pub, till in the foreground.*

**Start frame:** `masters/still/e2_venue.png`
**Tool:** Hailuo · Cinematic · 6s · image-to-video

```
[Static shot] The blurred figures in the background shift and move past each other continuously for the full six seconds, as a busy room does. The till in the foreground stays perfectly still and stays sharp. Its screen stays completely blank and evenly white. The camera does not move at all.
```
**Negative:**
```
text, letters, numbers, screen content, interface, icons, buttons, menus, watermark, logo, signage, extra fingers, deformed hands, faces in focus, foreground people, camera movement, zoom, pan, push in, shake, oversaturated, lens flare, cut, scene change
```

---

## C2 · The daylight desk
*Section 05, Cloud. Laptop, mug, plant, ordinary morning.*

**Start frame:** `masters/still/e3_cloud_day.png`
**Tool:** Luma Ray 2 · 6s · image-to-video

```
[Push in] The camera pushes in about eight centimetres across the full six seconds at one constant speed. Steam rises gently and continuously from the mug. The leaves of the plant move very slightly. The laptop screen stays completely blank and evenly white. Nothing else moves.
```
**Negative:**
```
text, letters, numbers, screen content, interface, icons, watermark, logo, hands, person, people, typing, camera acceleration, shake, fast motion, oversaturated, lens flare, cut, scene change
```

---

## C3 · The hall
*Section 02. Currently standing in for the Microsoft application well.*

**Start frame:** `masters/still/e4_dc.png`
**Tool:** Luma Ray 2 · 6s · image-to-video

```
[Pedestal up] The camera rises about six centimetres across the full six seconds at one constant speed. Status LEDs blink out of sync across the equipment. Nothing else in the frame moves. No turning, no tilting, no rotation.
```
**Negative:**
```
people, person, technician, hands, text, letters, numbers, watermark, logo, signage, doors opening, fog, haze, blue lighting, purple lighting, neon cyberpunk, hologram UI, lens flare, camera turning, banking, shake, cut, scene change
```

---

# Group 2 — the six story beats

These are the smallest images on the page and they sit in a vertical list. Keep
every move tiny. A story frame that lurches pulls the eye off the words next to
it, which is the opposite of the job.

## C4 · The problem
*Beat i. Dim empty pub after closing, one old register lit on the bar.*

**Start frame:** `masters/story/st1_problem.png`
**Tool:** Luma Ray 2 · 6s · image-to-video

```
[Static shot] Dust drifts slowly through the light above the bar. The single lamp over the register flickers once, faintly, at about four seconds. The room stays empty and completely still. The camera does not move at all.
```
**Negative:**
```
people, person, bartender, hands, text, letters, numbers, watermark, logo, signage, doors opening, camera movement, zoom, pan, shake, fast motion, strobing, oversaturated, lens flare, cut, scene change
```

---

## C5 · The build
*Beat ii. A laptop glowing on a kitchen table late at night.*

**Start frame:** `masters/story/st2_build.png`
**Tool:** Luma Ray 2 · 6s · image-to-video

```
[Push in] The camera pushes in about five centimetres across the full six seconds at one constant speed. The glow from the blank white screen brightens very slightly and settles. The room stays dark and still. Nothing else moves.
```
**Negative:**
```
text, letters, numbers, screen content, code on screen, interface, icons, watermark, logo, hands, person, people, typing, camera acceleration, shake, fast motion, oversaturated, lens flare, cut, scene change
```

---

## C6 · First install
*Beat iii. Two people running a cable to a new terminal. **The riskiest clip here** — two sets of hands is where these models fall apart.*

**Start frame:** `masters/story/st3_install.png`
**Tool:** Hailuo · Cinematic · 6s · image-to-video

```
[Static shot] One pair of hands feeds the cable slowly and steadily toward the terminal across the full six seconds in one continuous motion. Both people stay exactly where they are. The camera does not move at all.
```
**Negative:**
```
extra fingers, sixth finger, deformed hands, melting fingers, plastic skin, extra arms, third person entering frame, people walking, faces changing, text, letters, numbers, screen content, watermark, logo, signage, camera movement, zoom, pan, shake, fast motion, cut, scene change
```
*If this comes back mangled, do not spend a third credit on it — it is the one
clip that is genuinely better left as a still, and the page already handles that.*

---

## C7 · Iteration
*Beat iv. A grid of blank thermal receipts pinned to a wall.*

**Start frame:** `masters/story/st4_iteration.png`
**Tool:** Luma Ray 2 · 6s · image-to-video

```
[Static shot] The curled edges of the paper lift and settle very slightly, as though in a faint draught, continuously across the full six seconds. The pins do not move. The wall does not move. The camera does not move at all.
```
**Negative:**
```
text, letters, numbers, printed characters on the paper, receipt printing, handwriting, watermark, logo, paper falling, paper tearing, wind gust, hands, person, camera movement, zoom, pan, shake, cut, scene change
```

---

## C8 · Going wider
*Beat v. Four identical terminals on a workbench, screens blank and glowing.*

**Start frame:** `masters/story/st5_wider.png`
**Tool:** Luma Ray 2 · 6s · image-to-video

```
[Truck left] The camera slides sideways to the left about fifteen centimetres across the full six seconds at one constant speed, staying parallel to the bench. All four screens stay completely blank and evenly white. Nothing on the bench moves.
```
**Negative:**
```
text, letters, numbers, screen content, interface, icons, boot logos, watermark, logo, brand marks, hands, person, people, screens switching on or off, flickering, camera rotation, orbit, tilting, shake, fast motion, cut, scene change
```

---

## C9 · The stack closes
*Beat vi. A terminal, a rack unit and a metal token lit hard from above. The closing image of the story.*

**Start frame:** `masters/story/st6_stack.png`
**Tool:** Luma Ray 2 · 6s · image-to-video

```
[Orbit right] The camera arcs slowly to the right around the three objects by about ten degrees across the full six seconds at one constant speed. The hard overhead light sweeps across the metal surfaces as the angle changes. The three objects stay exactly where they are and do not move or rotate themselves.
```
**Negative:**
```
text, letters, numbers, currency symbols, bitcoin symbol, watermark, logo, brand marks, objects moving, objects rotating, objects floating, levitation, screen content, hands, person, fast orbit, camera shake, oversaturated, lens flare, cut, scene change
```

---

# Naming — this matters, the page wires itself off these

Drop them into `site/assets/video/` named exactly:

```
C1 → e2_venue.mp4        C4 → st1_problem.mp4     C7 → st4_iteration.mp4
C2 → e3_cloud_day.mp4    C5 → st2_build.mp4       C8 → st5_wider.mp4
C3 → e4_dc.mp4           C6 → st3_install.mp4     C9 → st6_stack.mp4
```

Each one mounts itself over the matching still. A clip that never arrives just
leaves its still in place — nothing breaks, so send them as they come rather
than waiting for the set.

---

# Export settings — read this before you export

**MP4, H.264, 6s.** Resolution caps that match how big these actually render:

| Clip | Renders at | Export |
|---|---|---|
| C1, C2, C3 (section plates) | up to 46rem wide | **1280×720** |
| C4–C9 (story beats) | about 26rem wide | **960×640** (3:2) |

**Target under 500 KB each.** If the tool only gives you one size, keep it and
send it — I transcode everything through `tools/faststart.py` anyway, which is
also what moves the `moov` atom to the front so playback starts before the file
finishes downloading.

## The weight problem, said plainly

Four clips already cost 2.9 MB. Nine more at Hailuo's default export would put
the page over 12 MB, and you have told me twice that it loads too slowly. So:

- These nine are **lazy, one viewport ahead** — same as the existing four. They
  are never all in flight at once.
- I am capping the story clips at 960px and will re-encode anything that lands
  fat.
- If the total still runs over budget I will drop the three weakest story clips
  back to stills. The page is built so that costs nothing but the file.

Send them in whatever order they finish. I will wire, transcode and weigh each
one as it lands.
