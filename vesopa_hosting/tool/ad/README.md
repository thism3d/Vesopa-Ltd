# The Bangladesh advert

A 33-second 1080p promo for `cloud.vesopa.com`, narrated in Bangla, for the
BANGLADESH40 offer. Built here rather than in an editor so that it can be
rebuilt: the offer changes, somebody wants a different voice, the price list
moves — and it is one command, not an afternoon of dragging clips.

```bash
python tool/ad/narrate.py     # speak the Bangla, measure every line
python tool/ad/render.py      # draw the picture to it, encode, then check
python tool/ad/render.py --remux   # sound again over the frames already drawn
python tool/ad/render.py --check   # is the finished file sound?
```

Output: `~/Documents/Vesopa-Ads/vesopa-cloud-bangladesh-16x9-1080p.mp4`.

---

## The voice comes first, and the picture is cut to it

`narrate.py` synthesises each line on its own and writes `timing.json` with the
real measured duration of each. `render.py` reads that, tells the page where
every scene begins, and photographs `seek(t)` at 1/30s intervals.

That order is the whole design. A line of Bangla is not the length you guess it
is — the same sentence runs about a second longer than its English — so timing
the picture first and hoping the voice fits is how a caption ends up a beat
behind the word it belongs to for thirty seconds.

Nothing in `ad.html` animates itself. No CSS animation, no
`requestAnimationFrame`: every position, opacity and number is a function of
`t`. A frame is therefore reproducible, and a slow screenshot on a headless
browser — which is every screenshot — cannot drift the picture against the
sound.

## The voice is edge-tts, not Gemini

Gemini was the intention. Gemini answers `429 — Your prepayment credits are
depleted` to every call, measured 2026-09-17, so the advert would have had no
voice at all. `bn-BD-PradeepNeural` is a Microsoft neural Bangladeshi voice,
chosen by the owner from a sample of both it and `bn-BD-NabanitaNeural`.

Switching back later is one field: `voice` in `script.json`.

The line text goes to Microsoft's endpoint to be synthesised. It is marketing
copy written for a public advert, so nothing private leaves this machine.

## It is checked for sound, because the last one shipped silent

`render.py --check` is not politeness. It asserts that the file carries a video
stream, an audio stream, a sensible duration, and — the part a stream
declaration does not tell you — that there is actually signal in it, by
measuring the mean volume. The script exits non-zero and refuses to call itself
finished if any of that is missing. A promo with no sound looks exactly like a
promo with sound until somebody presses play.

The track is also brought to **-14 LUFS with a -1.5 dBTP ceiling**, in two
passes. The first cut measured -21.1 LUFS; YouTube normalises to about -14 by
turning loud things down and quiet things not at all, so a -21 advert plays
audibly quieter than whatever ran before it.

## Every claim is checked against the live offer

Not written from memory, and not invented. `BANGLADESH40` is
`percent / 40 / hosting` with `first_order_only = 1` and `countries = BD`, so
the narration says **new customers** and says **Bangladesh**; an advert that
promised it to everybody would be selling something the basket then refuses.

Three things were corrected during the build, and they are the kind of thing
worth writing down:

- **The percentage is in Latin digits.** Everything else is Bangla and the site
  writes prices in Bengali numerals, so `৪০%` was the first choice. But the
  offers page renders `40% ছাড়` straight out of the coupon row, and an advert
  that promises ৪০ and lands on 40 makes the reader check whether they are the
  same offer. Worse, ৪০ is the shape of `80` to anyone reading Latin numerals —
  a misread that promises double what the basket gives.
- **Support is not in Bangla.** The line said "প্যানেল আর সাপোর্ট, সবই বাংলায়".
  The panel is — it was translated string by string. The support is not;
  the site says "ইউকে সাপোর্ট, একজন মানুষ" and means it. The claim is now the
  half that is true.
- **The free domain comes with a yearly plan**, not with every plan, so that
  condition is on screen with the others.

No taka figure is spoken or shown anywhere, on purpose: a price in a video
outlives the price list, and this one is already sold in four currencies.

## A second advert: the vertical cut

```bash
python tool/ad/narrate.py --script script-vertical.json
python tool/ad/render.py  --script script-vertical.json
python tool/ad/render.py  --script script-vertical.json --check
```

Output: `~/Documents/Vesopa-Ads/vesopa-cloud-godigital-9x16-1080p.mp4`.

**A format is a script file, not a fork.** `--script` carries the shape, the
page, the output name and where its frames and audio live, so both adverts run
through the same renderer. Two renderers would have drifted apart the first
time one of them was fixed — and the first thing that gets fixed in a pipeline
like this is always the sound.

The vertical one sells a different thing on purpose. 16x9 carries the 40%
hosting discount; 9x16 leads with Vesopa AI speaking Bangla, shows the site
builder building, and closes on the GoDigital bundle — a `.site` domain and the
first month of hosting for ৳381. It is built for a phone held close and watched
with the sound off as often as not: one large thing per screen, and everything
inside a safe area that clears the platform's own chrome top and bottom.

**This one does speak a price, and the 16x9 deliberately does not.** ৳381 is not
a rate-card number that drifts — it is what the bundle costs, pinned by the
coupon row itself, and the day the offer ends the advert ends with it. It was
driven end to end on the live basket before the line was written: a `.site` at
৳297 plus Starter monthly at ৳893 came to ৳1,190, GODIGITAL took ৳809 off, and
the total was ৳381.00.

## What is in here

| | |
|---|---|
| `script.json` | the 16x9 lines, the voice, and why each claim is worded as it is |
| `script-vertical.json` | the 9x16 lines, and the shape, page and output name for that cut |
| `narrate.py` | speaks them, measures them, writes the timing file |
| `ad.html` | the 16x9 picture, as one pure function of `t` |
| `ad-vertical.html` | the 9x16 picture, same contract, built for a phone |
| `render.py` | photographs it, builds the track, encodes, checks |
| `audio/`, `audio-vertical/` | the synthesised lines, kept so the picture can be redrawn without calling the service again |
| `frames*/` | build output, not committed |
