# Vesopa Software — Asset & Production Brief
### Everything I need from you to build vesopasoftware.com

Version 1 · 31 Aug 2026 · Target: 7-section scroll-driven site, desktop + mobile parity

---

## 0. What I already have

I read vesopaepos.com and cloud.vesopa.com in full, so I have your product facts, plan
pricing, tone of voice and existing image library. vesopasoftware.com is a coming-soon
page and pay.vesopa.com blocks crawlers, so those two are blind spots.

Your existing copy is genuinely good — plain, confident, unhyped ("It keeps taking money",
"did not ask for cPanel"). The site I build will sound like that. I'm not going to write
"empowering businesses to unlock synergy" over the top of it.

**Established brand facts I'll build from:**

| | |
|---|---|
| EPOS theme colour | `#a5c715` (lime) |
| Cloud theme colour | `#111111` |
| Entity | VESOPA SOFTWARE LTD, Baglan, Port Talbot, SA12 7AX |
| EPOS entity | VESOPA EPOS LTD, 1 High Street, Pontardawe, Swansea, SA8 4HU |
| Phone / email | +44 1792 316282 · info@vesopa.com |
| Hardware partners | Dojo, Sam4s, Oxhoo, ICRTouch, Newbridge |
| Pay direction | BTC, Lightning, USDT — per your 9 Aug blog post |

---

## 1. The one decision that changes everything

**Who is the client you're hunting?**

- **(A) End businesses** — pubs, cafés, retailers who buy EPOS seats and hosting plans.
- **(B) Bespoke software clients** — companies paying Vesopa to build them software.
- **(C) Both, A as proof of B.**

I've assumed **(C)** throughout this brief: the site proves competence by showing three
shipped products, then says "we'll build yours." If it's actually (A) or (B), roughly a
third of the asset list changes. Tell me before you spend generation credits.

---

## 2. Art direction (so every asset matches)

The trap here is obvious and I want to name it: near-black background plus one acid-green
accent is the house style of every AI-generated software site in 2026. Your lime is real
brand equity so it stays, but it can't be the only idea.

**The escape route: the site changes material as you scroll.**

Sections 1–4 are ink-dark, lit like a bar at night — the world your EPOS actually lives in.
At the Cloud section the whole page **inverts to paper-white and stays there** through Pay
and the close. Cloud is the thing you want promoted; giving it the only daylight on the page
makes it the loudest moment without a single extra effect. Nothing else on the site does
this, so it can't read as a template.

**Palette (name these when generating):**

| Token | Hex | Use |
|---|---|---|
| Ink | `#0B0E0A` | Sections 0–4 ground |
| Paper | `#F2EFE6` | Cloud → Pay ground (thermal receipt white, slightly warm) |
| Lime | `#A5C715` | Brand signal — screens, rim light, one CTA per section |
| Signal | `#E4761B` | Pay only (heat, settlement, Lightning) |
| Slate | `#2A312B` | Surfaces, terminal bodies, rack metal |

**Type direction** (confirm or veto):
- Display: **Archivo Expanded**, variable width ~120, weight 600. Industrial, wide, reads
  as machinery rather than SaaS.
- Body: **Source Serif 4**. A serif on a software house site is unusual and it matches how
  your copy already talks — like a person, not a brochure.
- Figures only: **Martian Mono**, for prices, uptime, version numbers. Monospace is normally
  a generated-page tell, but on a company whose product literally prints monospace receipts
  it's the vernacular, not decoration.

**Style suffix — append to EVERY image and video prompt, unchanged:**

```
shot on ARRI Alexa 35, 40mm, T2.0, shallow depth of field, single hard key light from
camera-left at 45 degrees, cool practical fill, deep near-black background #0B0E0A,
one lime-green #A5C715 practical light source as screen glow or rim, high micro-contrast,
crushed blacks, clean specular highlights, fine 35mm grain, photographic, UK interior,
no text, no signage, no logos, no watermark
```

**Negative prompt — every generation:**

```
text, letters, numbers, watermark, logo, brand marks, signage, extra fingers, deformed
hands, plastic skin, waxy faces, stock-photo smile, oversaturated, HDR halo, lens flare,
fisheye, tilt-shift, vignette, American diner, neon cyberpunk, hologram UI, floating
glass panels, blue tech grid
```

That last line matters. "Hologram UI" and "blue tech grid" are what these models default to
for anything software-shaped, and it's exactly the generic look you said you don't want.

---

## 3. Particles — direct answer to your question

**One system. One draw call. It is the spine of the entire site.**

The concept: every particle is a transaction. The field is the ledger. As you scroll it
**morphs between silhouettes** — the till, the app window, code, a server rack, a lightning
bolt, and finally the Vesopa mark. Same particles the whole way down, never reset. That's
the memorable thing; everything else on the page stays quiet.

### Counts

Sized to power-of-two GPGPU textures, because positions live in a floating-point framebuffer
that ping-pongs each frame:

| Tier | FBO | Particles | Point size | Target |
|---|---|---|---|---|
| Desktop, discrete GPU | 256×256 | **65,536** | 1.6px | 60fps |
| Desktop, integrated | 181×181 | **32,768** | 2.0px | 60fps |
| Tablet | 128×128 | **16,384** | 2.4px | 60fps |
| Mobile | 64×64 | **4,096** | 3.0px | 60fps on iPhone 12 |
| `prefers-reduced-motion` | — | static baked frame | — | no simulation |

Mobile gets 4,096 and it will still look dense, because at 3px with additive blending the
sprites overlap. Pushing mobile higher is how these sites end up at 12fps and get closed.
Detection is by an actual timed first-frame benchmark, not by user-agent sniffing.

### Rendering
Additive blending, no depth write, single `THREE.Points` with a custom shader. Curl-noise
drift on idle, damped-spring lerp toward the target position texture on scroll. Colour is
per-particle, sampled from the target shape so the field carries the section's colour.

### What I need from you to make it work
Morph targets are baked from **your 3D models**. I sample each mesh's surface at exactly
65,536 points and write XYZ into a position texture. So the GLBs in §4 are not decoration —
they are the particle system's source data. Sampling needs closed, reasonably even geometry;
a model with holes and 40k-tri density in one ear samples badly.

**No 3D model needed for:** the Vesopa mark (I extrude the SVG in code — cleaner than any
generator will give us) and the code-bracket shape (generated from text geometry).

---

## 4. 3D models — Trellis / Tripo Ultra PBR

Both tools work best image→3D, so each entry has a **T2I reference prompt first**, then the
3D settings. Generate the reference at 1024×1024, plain mid-grey background, object centred,
3/4 view, no cropping. Do **not** append the style suffix to reference images — flat, even
lighting reconstructs far better.

**Delivery for all:** `.glb`, Y-up, real-world scale in metres, origin at base centre,
2K PBR textures, plus a decimated 25k-tri version alongside the raw.

---

**M1 · `till_terminal.glb`** — hero object, section 1 morph target

```
industrial 15-inch touchscreen point-of-sale terminal on a matte dark metal stand,
blank powered-off black screen, thin bezel, angled 20 degrees, brushed aluminium base,
one power cable, product photography, three-quarter view, plain mid-grey seamless
background, even softbox lighting, no logos, no screen content
```
Tripo Ultra PBR · symmetry on · 120k tri · quad remesh on

---

**M2 · `card_terminal.glb`** — section 1 and section 6

```
handheld card payment terminal, dark matte plastic body, rubber keypad, small blank
screen, contactless reader ring on top face, standing upright, product photography,
three-quarter view, plain mid-grey background, even lighting, no logos, no card
```
Tripo Ultra PBR · 80k tri

---

**M3 · `thermal_printer.glb`** — section 1 detail, and the story section

```
80mm thermal receipt printer, dark grey housing, open paper lid, a short curl of blank
white receipt paper emerging, front-facing three-quarter view, plain mid-grey background,
even lighting, no printed text on the paper
```
Tripo Ultra PBR · 90k tri · **paper roll must be a separate mesh** (I animate it printing)

---

**M4 · `handheld_tablet.glb`** — floor service, section 1

```
10-inch tablet in a rugged black protective case with a hand strap on the back, blank
black screen, held upright at an angle, product photography, plain mid-grey background,
even lighting, no logos
```
Trellis · standard density

---

**M5 · `server_blade.glb`** — section 5, Cloud

```
1U rack-mount server, front bezel only, perforated grille, row of small status LEDs on
the left, two drive bays, dark grey powder-coated steel, straight-on slightly angled
view, plain mid-grey background, even lighting, no branding
```
Tripo Ultra PBR · 100k tri · LEDs as separate material for emissive

---

**M6 · `rack_column.glb`** — section 5 particle morph target

```
open 21U server rack column filled with identical dark rack-mount units, side rails
visible, cable arms at the rear, no doors, straight-on view, plain mid-grey background,
even lighting, no branding, no cable spaghetti
```
Tripo Ultra PBR · 150k tri — this is a *silhouette* source, detail matters less than
an even, closed surface

---

**M7 · `settlement_token.glb`** — section 6, Pay

```
thick machined metal disc token, 40mm, bevelled edge, milled reeded rim, a single
lightning bolt shape in raised relief on the face, dark gunmetal with warm bronze wear
on the high points, resting at an angle, macro product photography, plain mid-grey
background, even lighting, no text, no symbols, no currency marks
```
Tripo Ultra PBR · 60k tri · **Generic bolt only.** Do not generate the Bitcoin ₿, the
Tether logo, or any real currency mark in 3D — see §8.

---

## 5. Video — Kling / Hailuo / Luma / Hunyuan

**Universal specs, no exceptions:**
- 5 seconds, 24fps, single continuous shot, no cuts
- Camera: locked off, or one slow push/drift only. No orbits, no whip pans, no shake.
- First and last frame must be compositionally near-identical → it loops
- Deliver **MP4 H.264 4K** *and* a **WebP frame sequence at 1440×810** (scroll-scrubbing
  needs frames; you can't seek an mp4 smoothly on iOS Safari)
- **Any screen visible in shot must be blank and glowing neutral white.** I composite your
  real UI onto it. A model-hallucinated interface is the single fastest way to look fake to
  a client who sells software.

---

**V1 · Hero — the tap** (Kling 2.5 Pro, best lip on macro physics)
```
Macro shot, a hand places a bank card flat onto the contactless reader of a payment
terminal on a dark bar counter at night. Extreme shallow depth of field. The reader ring
pulses once with lime-green light. Camera pushes in 10 centimetres over five seconds.
Background bar lights fall completely out of focus.
[+ style suffix] [+ negative prompt]
```

**V2 · EPOS — the counter** (Hailuo)
```
Over-the-shoulder shot behind a bartender working a touchscreen till during evening
service. Their hand moves across the screen. The screen is blank and glows neutral white.
A blurred queue of customers waits beyond. Camera is locked off. Only the hand moves.
[+ style suffix] [+ negative prompt]
```

**V3 · The pass** (Kling)
```
A thermal printer on a stainless steel kitchen shelf feeds out a blank white ticket.
Steam drifts through the frame from below. A chef's hand enters at the very end and
tears the ticket away. Locked-off camera, shallow focus on the printer.
[+ style suffix] [+ negative prompt]
```

**V4 · The build** (Luma Ray — best at abstract material motion)
```
Abstract. Thousands of small dark glass fragments suspended in black space slowly rotate
and assemble into a single flat rectangular slab. Lime-green light passes across the
fragments as they lock together. Slow, deliberate, no impact, no shatter. Camera drifts
right by ten centimetres.
[+ style suffix] [+ negative prompt]
```

**V5 · Cloud — the aisle** (Kling, 4K)
```
Camera moves slowly forward down a cold-lit aisle between two rows of server racks.
Hundreds of small status LEDs blink out of sync. Cold white light from above, one lime-
green LED strip running along the floor. No people. Continuous forward dolly, constant
speed, no acceleration.
[+ style suffix] [+ negative prompt]
```
This one is the Cloud section's opening frame and the most important video on the site —
generate 4 variants and pick.

**V6 · Pay — settlement** (Hunyuan or Luma)
```
Abstract macro. A pool of dark liquid metal on a black surface pulls itself upward and
solidifies into a thick machined disc. A single warm amber arc of electricity crosses the
surface once as it sets. Extremely slow, five seconds, no splash, no droplets.
[+ style suffix, replacing lime-green with warm amber #E4761B] [+ negative prompt]
```

**V7 · Place — Wales** (optional, Luma; or licence real drone footage)
```
Aerial drone shot drifting slowly over a Welsh coastal town at dawn, low mist over slate
rooftops, sea on the right, hills behind. Overcast soft light. Constant slow forward
motion, no orbit.
[+ style suffix, no lime-green light source] [+ negative prompt]
```

---

## 6. The animated story — 6 beats

You said "animated story" and I think it should be the emotional centre of the page: the
one place a prospective client stops scrolling and reads.

**I need the real history from you** — founding year, what the first venue was, when the
Microsoft Store listing happened, the moment Cloud got spun up. Placeholders below are
shaped correctly but the specifics are invented and must be replaced before this ships.
A fabricated origin story is worse than no origin story.

Generate all six as **stills**, chained image-to-image from beat 1 so the style holds. Each
becomes a scroll-pinned panel; the particle field carries between them.

| # | Beat | Prompt (+ style suffix, + negative) |
|---|---|---|
| 1 | The problem | `A dim empty pub after close, one old cash register on the bar, chairs stacked on tables, a single warm light left on above the till.` |
| 2 | The build | `A laptop open on a domestic kitchen table late at night, screen glowing lime-green onto a cold cup of tea and a paper notebook covered in handwriting, the rest of the room dark.` |
| 3 | First install | `Two people crouched behind a bar counter running a cable to a new touchscreen terminal, mid-afternoon, empty pub, daylight through a front window.` |
| 4 | Iteration | `A wall of small printed thermal receipts pinned in a grid, curling at the edges, lit from one side. Nothing written on them.` |
| 5 | Going wider | `A dark room with four identical touchscreen terminals on a workbench, all powered on with blank glowing white screens, cables running to the floor.` |
| 6 | The stack | `Three objects on a dark surface, lit from above, evenly spaced: a touchscreen terminal, a rack server unit, and a metal disc token. Product still life, hard shadows.` |

Beat 6 is the payoff — EPOS, Cloud, Pay. Hold it, then the particles form the Vesopa mark
and the page inverts to paper.

---

## 7. What I need that AI cannot generate

These are the blockers. Everything above is optional polish; this list is not.

**Screenshots — real, uncompressed, no phone photos of monitors:**
- [ ] EPOS sale screen, dark mode, 2560×1600 PNG, with plausible demo data (real item
      names, real prices, a table number). Empty screens kill the section.
- [ ] EPOS sale screen, light mode, same dimensions — the light/dark switch is a strong
      scroll moment
- [ ] Back Office live dashboard with a populated chart
- [ ] Table Designer with a real floor plan
- [ ] Receipt Designer with the paper preview visible
- [ ] Microsoft app #1 — main screen ×2
- [ ] Microsoft app #2 — main screen ×2
- [ ] Cloud control panel, the one you show at "Built for people who did not ask for cPanel"
- [ ] Vesopa Pay — whatever exists today, even if it's a Figma frame

**Brand:**
- [ ] Vesopa Software logo as **SVG** (I extrude it in 3D — a PNG can't be)
- [ ] Vesopa Cloud and Vesopa Pay lockups, SVG
- [ ] Font licence: are we on Google Fonts, or do you have a foundry licence?

**Facts:**
- [ ] **The two Microsoft applications — names, what they do, who they're for, Store links.**
      Currently the largest hole in this brief; I've reserved sections 2 and 3 and can't
      write a word of them.
- [ ] Real founding history for §6
- [ ] Vesopa Pay: what is **live**, what is **beta**, what is **announced**? This must be
      precise. Payment claims are regulated and I won't write ambiguous ones.
- [ ] Is Vesopa FCA-registered / does it hold any payment permissions? If not, Pay is
      described as infrastructure in development and nothing more.
- [ ] 2–3 named client references with permission to use their name and logo
- [ ] Deploy target — I assume **cloud.vesopa.com** (it would be strange not to), Node or
      static?

---

## 8. Legal guardrails I'm holding to

- **Microsoft trademarks.** No AI-generated Windows logos, Microsoft Store badges, or
  Copilot-style marks — those come from Microsoft's official brand asset pack only, used
  per their guidelines. Generating them is both a trademark issue and an instant credibility
  loss for anyone who knows the brand.
- **Partner logos** (Dojo, Sam4s, Oxhoo, ICRTouch, Newbridge) — use the files you already
  serve on vesopaepos.com. Confirm you have permission to display them on a *new* site;
  partner agreements are usually per-property.
- **Currency marks.** No ₿, no Tether logo, no bank card network logos in generated 3D or
  imagery. Generic bolt and generic card only.
- **Faces.** Any AI-generated person is fine as an anonymous hand or a blurred figure. Do
  not use a generated person as a named testimonial. Your real testimonials from Pontardawe
  RFC, Bar 98 and the others are worth more anyway.
- **Testimonials** carry over only with written permission for the new domain.

---

## 9. Performance budget — the mobile promise

You said you want every scroll felt on mobile. That's a performance commitment, not a design
one, and it's the constraint I'll design against:

| Metric | Budget |
|---|---|
| Initial mobile payload | ≤ 1.4 MB |
| LCP, 4G, mid-range Android | ≤ 2.0s |
| Total page weight, all lazy assets in | ≤ 6 MB |
| Frame time during scroll | ≤ 16ms on iPhone 12 / Pixel 7 |
| Main thread block during scroll | 0ms — all motion on GPU or in a worker |

Consequences you should agree to now:
- Videos are **poster + lazy**, decoded only when within one viewport
- Scroll scrubbing uses frame sequences on desktop, and a **single still with transform-only
  parallax on mobile** — this is deliberate, it will still feel alive, and it's the
  difference between a site that impresses on a client's iPhone and one that stutters on it
- WebP everywhere, AVIF where supported
- `prefers-reduced-motion` gets a fully composed static version, not a broken one

---

## 10. On charges

I'm Claude — I don't invoice, so there's nothing to settle on my side beyond your Anthropic
subscription. If you meant what **Vesopa** should charge for builds like this, here's a
starting rate card to react to, positioned so it feeds cloud.vesopa.com rather than competing
with it:

| Tier | Scope | Indicative |
|---|---|---|
| Launch | 5-page marketing site, your copy, hosted on Vesopa Cloud Business | £1,800–2,500 |
| Signature | Scroll-driven, custom motion, generated asset suite — i.e. this site | £6,000–9,000 |
| Product | Bespoke application, discovery + build + support retainer | Day rate, £550–750 |

Every tier includes 12 months of Vesopa Cloud. The hosting is the hook, not the margin —
one build client on Business at $91/yr is worth far less than a build client who never
leaves your panel.

---

## 11. Generation order — do it in this sequence

1. **Answer §1 and the Microsoft app question.** Nothing else is safe to generate first.
2. **M1, M5, M7** — three GLBs. I bake particle morph targets and prove the scroll spine
   works end to end before you spend anything else.
3. **V1 and V5** — hero and Cloud aisle. If those two land, the site lands.
4. Send screenshots and the SVG logo.
5. I build the working skeleton — real scroll, real particles, placeholder art.
6. You review on your own phone. We adjust the budget in §9 against reality.
7. Then generate the remaining video, the six story beats, and M2/M3/M4/M6.

Doing it in this order means if the particle spine feels wrong on your phone, you've spent
three model generations finding out instead of forty.
