# Vesopa — Final Command Pack
### Every prompt fully assembled. Nothing to append. Paste as-is.

Tools: **Nano Banana Pro** (primary) · **Flux 1 Dev** (dark cinematic) · **Nano Banana**
(1K drafts) · **SD 3.5 Large** (tiles only) · **Kling / Hailuo / Luma / Hunyuan** (video).

Negative fields: Flux Dev and both Nano Bananas have none — the exclusions are already
written into the positive text below. SD 3.5 Large and all four video tools do have one, so
those blocks carry a separate NEGATIVE line. Copy both lines where both appear.

---

# GROUP A — 3D reference plates
**Nano Banana Pro · 1:1 · 2K · these feed Tripo, nothing else**

If you can photograph the real hardware, skip to Group H and clean the photo instead.

---
**R1 · Till terminal → M1**
```
An industrial 15-inch touchscreen point-of-sale terminal on a matte dark metal stand, blank powered-off black screen, thin bezel, screen angled back 20 degrees, brushed aluminium base plate, a single power cable coiled at the base. Product photography on a plain mid-grey seamless background, flat even softbox lighting from all sides, no cast shadows, the object centred and fully in frame with clear margin on every side, three-quarter view from slightly above, sharp focus throughout, no depth of field, neutral colour, plain unbranded surfaces, no text or logos anywhere in frame.
```

**R2 · Card terminal → M2**
```
A handheld card payment terminal standing upright, dark matte plastic body, rubber keypad with blank unmarked keys, a small blank screen, a contactless reader ring moulded into the top face, rounded corners, edges slightly worn. Product photography on a plain mid-grey seamless background, flat even softbox lighting from all sides, no cast shadows, the object centred and fully in frame with clear margin on every side, three-quarter view from slightly above, sharp focus throughout, no depth of field, neutral colour, plain unbranded surfaces, no text or logos anywhere in frame.
```

**R3 · Thermal printer → M3**
```
An 80mm thermal receipt printer, dark grey housing, paper lid open at the top, a short curl of blank white receipt paper emerging and falling forward, tear bar visible along the front edge, rubber feet. Product photography on a plain mid-grey seamless background, flat even softbox lighting from all sides, no cast shadows, the object centred and fully in frame with clear margin on every side, three-quarter view from slightly above, sharp focus throughout, no depth of field, neutral colour, plain unbranded surfaces, no printing on the paper, no text or logos anywhere in frame.
```

**R4 · Handheld tablet → M4**
```
A 10-inch tablet in a rugged black protective case with a moulded hand strap across the back, blank black screen, held upright at a slight angle, thick shock-absorbing corners. Product photography on a plain mid-grey seamless background, flat even softbox lighting from all sides, no cast shadows, the object centred and fully in frame with clear margin on every side, three-quarter view from slightly above, sharp focus throughout, no depth of field, neutral colour, plain unbranded surfaces, no text or logos anywhere in frame.
```

**R5 · Server blade → M5**
```
A 1U rack-mount server seen from the front, perforated grille across the face, a vertical row of six small status LEDs on the left, two drive bays on the right, dark grey powder-coated steel, mounting ears with visible screw holes. Product photography on a plain mid-grey seamless background, flat even softbox lighting from all sides, no cast shadows, the object centred and fully in frame with clear margin on every side, three-quarter view from slightly above, sharp focus throughout, no depth of field, neutral colour, plain unbranded surfaces, no text or logos anywhere in frame.
```

**R6 · Rack column → M6**
```
An open 21U server rack column filled with eleven identical dark rack-mount units stacked evenly, vertical side rails visible on both sides, no doors and no side panels, cable management arms at the rear, seen straight on from the front. Product photography on a plain mid-grey seamless background, flat even softbox lighting from all sides, no cast shadows, the whole rack fully in frame with clear margin above and below, sharp focus throughout, no depth of field, neutral colour, plain unbranded surfaces, no gaps or holes through the structure, no text or logos anywhere in frame.
```

**R7 · Settlement token → M7**
```
A thick machined metal disc token 40mm across, bevelled edge, milled reeded rim, a single plain lightning bolt shape in raised relief on the face, dark gunmetal finish with warm bronze wear on the raised edges, resting flat and angled slightly toward camera. Product photography on a plain mid-grey seamless background, flat even softbox lighting from all sides, no cast shadows, the object centred and fully in frame with clear margin on every side, three-quarter view from slightly above, sharp focus throughout, no depth of field, neutral colour, no currency symbols, no letters or numbers anywhere in frame.
```

---

# GROUP B — Tripo / Trellis settings
No prompt. Upload the approved R-plate, set these, export `.glb` Y-up, metres, origin at base
centre, 2K PBR, plus a 25k-tri decimated copy.

| ID | Tool | Settings |
|---|---|---|
| M1 | Tripo Ultra PBR | symmetry ON · 120k tri · quad remesh ON · PBR ON · texture 2K |
| M2 | Tripo Ultra PBR | symmetry ON · 80k tri · quad remesh ON · PBR ON |
| M3 | Tripo Ultra PBR | symmetry OFF · 90k tri · quad remesh ON · paper curl as separate mesh |
| M4 | Trellis | image-to-3D · standard density · defaults |
| M5 | Tripo Ultra PBR | symmetry ON · 100k tri · PBR ON · LEDs on their own material slot |
| M6 | Tripo Ultra PBR | symmetry ON · 150k tri · quad remesh ON · texture 1K |
| M7 | Tripo Ultra PBR | symmetry ON · 60k tri · PBR ON · texture 2K · metallic map required |

---

# GROUP C — Video
Nine clips. 5 seconds, 24fps, one continuous shot, loopable. Every screen in frame stays
blank and glowing white — the real UI goes on afterwards. Export MP4 H.264 at 4K **and** a
WebP frame sequence at 1440×810.

---

## V1 · Hero — the tap
**FRAME · Flux 1 Dev · 16:9 · 2048px · guidance 3.5 · 40 steps**
```
Macro close-up of a hand holding a plain unmarked bank card just above the contactless reader of a dark payment terminal resting on a worn wooden bar counter at night, extreme shallow depth of field, the reader ring lit lime-green, blurred amber bar lights far behind. Shot on ARRI Alexa 35, 40mm lens at T2.0, single hard key light from camera-left at 45 degrees, cool practical fill, deep near-black background, high micro-contrast, crushed blacks, clean specular highlights, fine 35mm film grain, photographic, UK pub interior. Clean uncluttered composition, natural correct anatomy, one hand with five fingers, realistic skin texture, plain unbranded card and terminal, muted natural colour, straight rectilinear lens, no text or signage anywhere in frame.
```
**MOTION · Kling 2.5 Pro · image-to-video · 5s · CFG 0.5 · camera: Push in, slow**
```
The hand lowers the card flat onto the reader. The lime-green ring pulses once brightly then settles. The camera pushes in ten centimetres over the full five seconds at a constant speed. Nothing else in the frame moves. No cut.
```
```
NEGATIVE: text, letters, numbers, watermark, logo, brand marks, signage, extra fingers, deformed hands, plastic skin, oversaturated, HDR halo, lens flare, fisheye, vignette, neon cyberpunk, hologram UI, blue tech grid, cluttered background, camera shake, fast motion, second hand entering frame, card flipping, cut, scene change
```

---

## V2 · EPOS — the counter
**FRAME · Flux 1 Dev · 16:9 · 2048px**
```
Over-the-shoulder view from behind a bartender working a touchscreen till during evening service, their hand raised toward the screen, the screen completely blank and glowing flat neutral white, a blurred queue of customers waiting beyond the counter, dark pub interior. Shot on ARRI Alexa 35, 40mm lens at T2.0, shallow depth of field, single hard key light from camera-left at 45 degrees, cool practical fill, deep near-black background, the white screen glow as the only bright source, high micro-contrast, crushed blacks, fine 35mm film grain, photographic, UK pub interior. Clean uncluttered composition, natural correct anatomy, hands with five fingers, realistic skin texture, plain unbranded surfaces, an entirely blank evenly lit screen with nothing displayed on it, muted natural colour, straight rectilinear lens, no text or signage anywhere in frame.
```
**MOTION · Hailuo · image-to-video · 5s**
```
[Static shot] The bartender's hand moves across the blank glowing screen and taps it twice. The blurred figures behind shift slightly. The camera does not move at all. The screen stays completely blank and evenly white for the whole shot.
```
```
NEGATIVE: text, letters, numbers, watermark, logo, signage, interface appearing on screen, icons, buttons, menus, screen content, extra fingers, deformed hands, oversaturated, HDR halo, lens flare, fisheye, vignette, hologram UI, blue tech grid, camera movement, zoom, pan, cut
```

---

## V3 · The pass
**FRAME · Flux 1 Dev · 16:9 · 2048px**
```
A thermal receipt printer mounted on a stainless steel kitchen shelf, a blank white ticket half fed out of it and curling forward, steam drifting upward through the frame from below, hot dark kitchen behind, shallow focus held on the printer. Shot on ARRI Alexa 35, 40mm lens at T2.0, single hard key light from camera-left at 45 degrees, cool practical fill, deep near-black background, one lime-green practical light as a rim on the steel, high micro-contrast, crushed blacks, clean specular highlights, fine 35mm film grain, photographic, UK commercial kitchen. Clean uncluttered composition, plain unbranded printer, entirely blank unprinted paper, muted natural colour, straight rectilinear lens, no text or signage anywhere in frame.
```
**MOTION · Kling 2.5 Pro · image-to-video · 5s · camera: Static**
```
The printer feeds the blank ticket further out over three seconds. Steam continues drifting upward. At four seconds a chef's hand enters from the right and tears the ticket away in one clean motion. Locked-off camera throughout.
```
```
NEGATIVE: text, letters, numbers, printed characters on the paper, watermark, logo, signage, paper jam, crumpling, multiple hands, extra fingers, deformed hands, oversaturated, lens flare, fisheye, vignette, camera movement, zoom, cut
```

---

## V4 · The build
**FRAME · Flux 1 Dev · 16:9 · 2048px**
```
Thousands of small dark glass fragments suspended and floating in empty black space, partly assembled into the beginnings of a flat rectangular slab at the centre, lime-green light catching the edges of the fragments, deep black void surrounding them. Shot on ARRI Alexa 35, 40mm lens at T2.0, shallow depth of field, single hard key light from camera-left at 45 degrees, deep near-black background, one lime-green practical light source, high micro-contrast, crushed blacks, clean specular highlights, fine 35mm film grain, photographic. Clean uncluttered composition, muted natural colour, straight rectilinear lens, no text or signage anywhere in frame.
```
**MOTION · Luma Ray 2 · image-to-video · 5s**
```
The floating glass fragments rotate slowly and drift inward, locking together into one solid flat rectangular slab. A band of lime-green light passes across the surface from left to right as the last pieces join. Slow, deliberate, gravityless. No impact, no shatter, no debris. The camera drifts right by ten centimetres.
```
```
NEGATIVE: text, letters, watermark, logo, explosion, shattering, breaking apart, sparks, smoke, fire, fast motion, camera shake, oversaturated, lens flare, neon cyberpunk, hologram UI, blue tech grid, cut
```

---

## V5 · Cloud — the aisle
**Generate four. This is the most important clip on the site.**
**FRAME · Nano Banana Pro · 16:9 · 4K**
```
The view straight down a cold-lit aisle between two tall rows of dark server racks in an empty data hall, hundreds of small status LEDs across both walls of racks, cold white light from panels overhead, a single lime-green LED strip running along the floor down the centre of the aisle, perfect one-point perspective with the vanishing point centred. The aisle is completely empty with no people present. Shot on ARRI Alexa 35, 40mm lens at T2.0, shallow depth of field falling off toward the far end, deep near-black shadows between the racks, high micro-contrast, crushed blacks, clean specular highlights on the steel, fine 35mm film grain, photographic. Clean uncluttered composition, plain unbranded rack units, muted natural colour, straight rectilinear lens, no text or signage anywhere in frame.
```
**MOTION · Kling 2.5 Pro · image-to-video · 5s · 4K · camera: Forward dolly, constant**
```
The camera moves slowly and steadily forward down the aisle at a constant speed. Hundreds of small status LEDs blink out of sync across both walls of racks. No acceleration, no deceleration, no turning, no tilting.
```
```
NEGATIVE: people, person, technician, worker, hands, text, letters, numbers, watermark, logo, signage, camera acceleration, camera turning, banking, doors opening, fog, haze machine, blue lighting, purple lighting, neon cyberpunk, hologram UI, lens flare, cut
```

---

## V6 · Pay — settlement
**FRAME · Flux 1 Dev · 16:9 · 2048px**
```
Macro shot of a pool of dark liquid metal resting on a plain black surface, its surface tense and beginning to rise in the centre, warm amber light reflecting off the meniscus, deep black surrounding it. Shot on ARRI Alexa 35, 40mm lens at T2.0, extreme shallow depth of field, single hard key light from camera-left at 45 degrees, deep near-black background, one warm amber practical light source as a rim, high micro-contrast, crushed blacks, clean specular highlights, fine 35mm film grain, photographic. Clean uncluttered composition, a plain unmarked metal surface with no symbols or markings of any kind, muted natural colour, straight rectilinear lens, no text or letters anywhere in frame.
```
**MOTION · Hunyuan Video · image-to-video · 5s**
```
The pool of liquid metal draws itself upward and solidifies into a thick machined disc. A single arc of warm amber electricity crosses the surface once as it sets, then vanishes. Extremely slow and continuous throughout. No splash, no droplets, no ripples leaving the frame.
```
```
NEGATIVE: text, letters, numbers, currency symbols, bitcoin symbol, dollar sign, coins, gold, treasure, sparkle, glitter, watermark, logo, splash, droplets, spray, fast motion, camera shake, oversaturated, lens flare, cut
```

---

## V7 · Place — Wales
**FRAME · Nano Banana Pro · 16:9 · 4K**
```
An aerial view drifting over a Welsh coastal town at dawn, low mist sitting over slate rooftops, the sea on the right, green hills rising behind the town, overcast soft grey light with no visible sun. Shot on ARRI Alexa 35, 40mm lens, high micro-contrast, crushed blacks in the shadowed streets, fine 35mm film grain, photographic, British landscape. Clean uncluttered composition, muted natural colour, straight rectilinear lens, no text or signage anywhere in frame.
```
**MOTION · Luma Ray 2 · image-to-video · 5s**
```
The camera drifts slowly forward over the rooftops at a constant altitude and a constant speed. The mist moves gently. No orbiting, no banking, no descending, no rising.
```
```
NEGATIVE: orbit, banking, tilting, descending, sunrise flare, sun, birds, drone visible in frame, timelapse, fast clouds, text, watermark, logo, oversaturated, teal and orange grade, cut
```

---

## V8 · Microsoft application — desktop *(section 02)*
**FRAME · Flux 1 Dev · 16:9 · 2048px**
```
A slim silver laptop open on a dark desk in a quiet office at night, the screen completely blank and glowing flat neutral white, a closed notebook and a cold cup of tea beside it, window blinds behind with faint street light coming through. Shot on ARRI Alexa 35, 40mm lens at T2.0, shallow depth of field, single hard key light from camera-left at 45 degrees, cool practical fill, deep near-black background, the white screen glow as the only bright source, high micro-contrast, crushed blacks, fine 35mm film grain, photographic, UK office interior. Clean uncluttered composition, plain unbranded laptop, an entirely blank evenly lit screen with nothing displayed on it, muted natural colour, straight rectilinear lens, no people, no text or signage anywhere in frame.
```
**MOTION · Hailuo · image-to-video · 5s**
```
[Push in] The camera pushes in slowly toward the laptop across the full five seconds. The blank white screen glow brightens very slightly. Nothing else in the frame moves.
```
```
NEGATIVE: hands, person, people, typing, screen content, icons, windows, interface, text, letters, numbers, watermark, logo, brand marks, camera shake, fast motion, cut
```

---

## V9 · Microsoft application — touch *(section 03)*
**FRAME · Flux 1 Dev · 16:9 · 2048px**
```
A detachable-keyboard tablet computer standing on a kitchen worktop in a small business back room, the screen completely blank and glowing flat neutral white, stock boxes stacked out of focus behind it, early morning light through a high window. Shot on ARRI Alexa 35, 40mm lens at T2.0, shallow depth of field, single hard key light from camera-left at 45 degrees, cool practical fill, deep shadows, the white screen glow as the brightest source, high micro-contrast, crushed blacks, fine 35mm film grain, photographic, UK small business interior. Clean uncluttered composition, plain unbranded hardware, an entirely blank evenly lit screen with nothing displayed on it, muted natural colour, straight rectilinear lens, no people, no text or signage anywhere in frame.
```
**MOTION · Hailuo · image-to-video · 5s**
```
[Pedestal up] The camera rises four centimetres across the full five seconds. The blank glowing screen stays evenly lit. The out-of-focus background shifts gently with the move. Nothing else moves.
```
```
NEGATIVE: hands, person, people, screen content, icons, interface, text, letters, numbers, watermark, logo, brand marks, camera shake, fast motion, cut
```

---

# GROUP D — The story, section 04
**Nano Banana Pro · 3:2 · 2K**

Generate **ST1 first**. Approve it. Then attach ST1 as a reference image to every one of
ST2–ST6 — the instruction to do so is already written into each prompt below. Generated
independently they will not match and the section will read as a stock-photo grid.

---
**ST1 · The problem** *(no reference, this one sets the look)*
```
A dim empty pub after closing time, one old cash register sitting on the bar, chairs stacked upside down on the tables, a single warm light left on above the till, everything else falling into darkness. Shot on ARRI Alexa 35, 40mm lens at T2.0, shallow depth of field, one hard practical light above the till as the key, deep near-black background, high micro-contrast, crushed blacks, clean specular highlights on the bar surface, fine 35mm film grain, photographic, Welsh pub interior. Clean uncluttered composition, plain unbranded fittings, muted natural colour, straight rectilinear lens, no people, no text or signage anywhere in frame.
```

**ST2 · The build**
```
Using the attached image as the style reference — match its lighting, colour grade, lens, grain and world exactly. A laptop open on a domestic kitchen table late at night, its screen glowing lime-green onto a cold cup of tea and a paper notebook covered in handwriting, the rest of the room in darkness. Same camera, same film grain, same crushed blacks. Clean uncluttered composition, plain unbranded laptop, illegible handwriting with no readable words, muted natural colour, no people, no text or signage anywhere in frame.
```

**ST3 · First install**
```
Using the attached image as the style reference — match its lighting, colour grade, lens, grain and world exactly. Two people crouched behind a bar counter feeding a cable up to a new touchscreen terminal, mid-afternoon, the pub empty, flat daylight coming through a front window. Same camera, same film grain. Clean uncluttered composition, natural correct anatomy, hands with five fingers, faces turned away from camera, plain unbranded hardware, a blank dark screen, muted natural colour, no text or signage anywhere in frame.
```

**ST4 · Iteration**
```
Using the attached image as the style reference — match its lighting, colour grade, lens, grain and world exactly. A wall of small blank thermal receipts pinned in a neat grid, their edges curling away from the wall, lit hard from one side so each one casts its own small shadow. Same camera, same film grain, same crushed blacks. Clean uncluttered composition, entirely blank unprinted paper, muted natural colour, no people, no text or printed characters anywhere in frame.
```

**ST5 · Going wider**
```
Using the attached image as the style reference — match its lighting, colour grade, lens, grain and world exactly. A dark workshop room with four identical touchscreen terminals lined up on a workbench, all powered on with completely blank glowing white screens, cables running down to the floor. Same camera, same film grain, same crushed blacks. Clean uncluttered composition, plain unbranded hardware, entirely blank evenly lit screens with nothing displayed on them, muted natural colour, no people, no text or signage anywhere in frame.
```

**ST6 · The stack closes** *(the payoff frame — generate four, pick the cleanest shadows)*
```
Using the attached image as the style reference — match its colour grade, grain and world exactly. Three objects arranged evenly spaced on a dark surface and lit hard from directly above: a touchscreen point-of-sale terminal on the left, a rack-mount server unit in the centre, a small metal disc token on the right. Product still life, hard shadows falling toward camera, deep near-black background. Same film grain, same crushed blacks. Clean uncluttered composition, plain unbranded objects, blank dark screen, no currency symbols on the token, muted natural colour, no people, no text or signage anywhere in frame.
```

---

# GROUP E — Section stills

**E1 · Hero plate** *(behind the particles; also the mobile substitute for V1)*
**Nano Banana Pro · 16:9 · 4K**
```
A dark bar counter at night seen from a low angle, a payment terminal and a touchscreen till out of focus in the background, the wood grain of the counter sharp in the foreground, lime-green light spilling in from off-frame right. Shot on ARRI Alexa 35, 40mm lens at T2.0, extreme shallow depth of field, single hard key from camera-left at 45 degrees, deep near-black background, high micro-contrast, crushed blacks, clean specular highlights, fine 35mm film grain, photographic, Welsh pub interior. Clean uncluttered composition, plain unbranded hardware, blank dark screens, muted natural colour, straight rectilinear lens, no people, no text or signage anywhere in frame.
```

**E2 · EPOS venue**
**Flux 1 Dev · 3:2 · 2048px**
```
A busy Welsh pub interior during evening service seen from behind the bar, warm and crowded, figures blurred by motion, a touchscreen till in sharp focus in the foreground with a completely blank glowing white screen. Shot on ARRI Alexa 35, 40mm lens at T2.0, shallow depth of field, single hard key light from camera-left at 45 degrees, cool practical fill, deep near-black background, high micro-contrast, crushed blacks, fine 35mm film grain, photographic, UK pub interior. Clean uncluttered composition, natural correct anatomy, faces blurred and turned away, plain unbranded hardware, an entirely blank evenly lit screen with nothing displayed on it, muted natural colour, straight rectilinear lens, no text or signage anywhere in frame.
```

**E3 · Cloud, daylight** *(first image on the paper-white half — deliberately lit the opposite way)*
**Nano Banana Pro · 3:2 · 2K**
```
A small business owner's desk in bright daylight, a laptop with a completely blank glowing white screen, a mug, a small plant, a window with soft overcast light falling across the desk, warm off-white walls, calm and uncluttered. Soft even daylight, gentle contrast, no hard shadows, natural colour, photographic, UK interior, 50mm lens at f4. Clean uncluttered composition, plain unbranded laptop, an entirely blank screen with nothing displayed on it, no people, no text or signage anywhere in frame.
```

**E4 · Data centre exterior**
**Nano Banana Pro · 16:9 · 2K**
```
A plain low industrial building at dusk under a flat overcast sky, no windows, a fenced perimeter, one steel door, cooling units along the roofline, wet tarmac in the foreground reflecting the sky. Shot on ARRI Alexa 35, 40mm lens, deep near-black shadows, high micro-contrast, crushed blacks, fine 35mm film grain, photographic, British industrial estate. Clean uncluttered composition, plain unbranded building, muted natural colour, straight rectilinear lens, no people, no vehicles, no text or signage anywhere in frame.
```

**E5 · Pay**
**Nano Banana Pro · 3:2 · 2K**
```
A single machined metal disc token standing on its edge on a pale stone surface in bright even daylight, one hard shadow cast to the right, nothing else in the frame, extreme minimalism. Soft daylight from a large window, natural colour, photographic, 100mm macro lens at f5.6. Clean uncluttered composition, a plain unmarked token with no symbols, no currency marks, no letters or numbers anywhere in frame.
```

**E6 · Open Graph card** *(generate last, once the logo SVG exists)*
**Nano Banana Pro · 1200×630**
```
Using the attached logo as the exact mark to reproduce. A wide banner image: the attached logo centred on a deep near-black background, small and precise, with a faint lime-green rim light along its lower edge and a subtle field of fine dark particles fading toward the corners. Flat, restrained, high contrast. Reproduce the logo exactly as supplied with no alteration to its shape, weight or proportions. No other text anywhere in frame.
```

---

# GROUP F — Seamless tiles
**SD 3.5 Large · 2048×2048 · tiling ON.** This is the only tool you have with a real negative
field, so these carry the full block.

**F1 · Thermal paper**
```
Seamless tileable texture of blank white thermal receipt paper, very subtle fibre grain, faint warm off-white tint, extremely flat and even lighting, macro
```
```
NEGATIVE: text, letters, numbers, printing, watermark, logo, folds, creases, tears, shadows, vignette, seams, edges, border, perspective, depth of field, colour cast
```

**F2 · Brushed metal**
```
Seamless tileable texture of dark grey brushed anodised aluminium, fine horizontal grain, matte finish, flat even lighting, macro
```
```
NEGATIVE: scratches, dents, reflections, highlights, hotspot, rust, fingerprints, watermark, logo, text, seams, edges, border, vignette, perspective, depth of field
```

**F3 · Bokeh plate**
```
Out of focus lime-green and warm amber points of light scattered across a pure black background, heavy circular bokeh, no subject, random distribution
```
```
NEGATIVE: subject, object, person, shapes, pattern, grid, symmetry, text, letters, watermark, logo, blue, purple, teal, sharp focus, foreground element, vignette
```

Do not generate film grain, noise overlays, glow sprites or the particle sprite. Those are
shader code and I'll write them.

---

# GROUP H — Nano Banana Pro edit commands
These are the highest-value runs in the whole pack. Attach the image named in each.

**H1 · Real hardware → 3D reference plate** *(attach your photo of the actual terminal)*
```
Isolate the terminal from this photograph and place it on a plain mid-grey seamless background. Relight it with flat even softbox lighting from all sides and remove every cast shadow. Remove all branding, badges and printed markings from the hardware. Set the screen to solid black. Keep the object's exact geometry, proportions and surface finish unchanged. Centre it in frame with clear margin on every side, three-quarter view, sharp focus throughout, no depth of field.
```

**H2 · Put the real UI on the screen** *(attach the scene image, then the EPOS screenshot)*
```
Take the first image as the scene and the second image as an interface screenshot. Place the screenshot onto the till screen in the scene. Match the screen's perspective, corner geometry and scale exactly. Keep the existing screen glow, the reflection on the bezel and the light it casts on nearby surfaces. Do not alter anything else in the scene. Do not crop or restyle the interface.
```
Run this for the dark EPOS sale screen, the light one, both Microsoft applications and the
Cloud panel — five runs that replace an entire compositing stage.

**H3 · Day to night** *(attach E3)*
```
Change this scene from daylight to late evening. Replace the window light with cold blue dusk, make the room fall into deep near-black shadow, and keep the laptop screen as the only bright source in the frame. Keep the composition, framing and every object exactly where they are.
```

**H4 · Blank a hallucinated screen** *(attach any frame that came back with fake UI on it)*
```
Replace the content on the screen with a flat, evenly lit blank white surface. Keep the screen's existing glow, brightness and the light it casts on the surrounding scene exactly as they are. Change nothing else in the image.
```

**H5 · Aspect refit** *(attach any approved still)*
```
Change the aspect ratio to 9:16 by extending the background only. The main subject stays locked in its current position, scale and lighting. Do not re-render or restyle the subject.
```
Use H5 to make the mobile crops rather than generating portrait variants — it keeps the
frames identical across breakpoints, which the scroll timing depends on.

---

# ORDER OF WORK

1. **R1, R5, R7** in Nano Banana Pro *(or H1 on real photos)*
2. → **M1, M5, M7** in Tripo
3. **V5 frame** in Nano Banana Pro at 4K → **V5 motion** in Kling
4. Send me the three GLBs and the V5 clip. I bake the particle targets and you test on your phone.
5. Everything else once the spine is proven.

Steps 1–3 are six image runs, three model runs and one video run — under five dollars, and
enough to find out whether the whole idea works.
