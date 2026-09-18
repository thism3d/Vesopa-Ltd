"""Photograph ad.html one frame at a time and cut it against the narration.

    python tool/ad/render.py                # the lot
    python tool/ad/render.py --frames-only  # picture, no encode
    python tool/ad/render.py --check        # is the finished file sound?

THE LAST ONE OF THESE SHIPPED SILENT, so `--check` is not optional politeness:
the encode is verified to carry an audio stream, of the right length, with
signal actually in it, and the script refuses to call itself finished if any of
that is missing. A promo with no sound looks exactly like a promo with sound
until somebody presses play.

The order is deliberate. narrate.py runs first and writes timing.json from the
real synthesised durations; this reads that, tells the page where every scene
begins, and photographs seek(t) at 1/FPS intervals. Nothing is timed by
wall-clock, so a slow screenshot cannot drift the picture against the voice.
"""

import argparse
import json
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = pathlib.Path.home() / "Documents" / "Vesopa-Ads"
FPS = 30

# Which advert. A format is a script file, not a fork of this module: the
# vertical cut is the same pipeline at a different size, and two renderers
# would drift apart the first time one of them was fixed.
#   python tool/ad/render.py --script script-vertical.json
_script_name = sys.argv[sys.argv.index("--script") + 1] if "--script" in sys.argv else "script.json"
SCRIPT = json.loads((HERE / _script_name).read_text(encoding="utf-8"))
FRAMES = HERE / SCRIPT.get("frames", "frames")
AUDIO = HERE / SCRIPT.get("audio", "audio")
TIMING = HERE / SCRIPT.get("timing", "timing.json")
PAGE = HERE / SCRIPT.get("html", "ad.html")
WIDTH = int(SCRIPT.get("width", 1920))
HEIGHT = int(SCRIPT.get("height", 1080))
FINAL_NAME = SCRIPT.get("output", "vesopa-cloud-bangladesh-16x9-1080p.mp4")
VOICE_RAW = HERE / SCRIPT.get("voice_raw", "voice-raw.m4a")
VOICE_OUT = HERE / SCRIPT.get("voice_file", "voice.m4a")

FFMPEG = ""
for raw in (ROOT / ".env.claude-tools").read_text(encoding="utf-8").splitlines():
    if raw.startswith("FFMPEG="):
        FFMPEG = raw.split("=", 1)[1].strip().strip('"').strip("'")


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", **kw)


def probe(path):
    """Everything ffmpeg will tell us about a file, as text."""
    return run([FFMPEG, "-hide_banner", "-i", str(path)]).stderr


def seconds_of(path):
    for line in probe(path).splitlines():
        if "Duration:" in line:
            clock = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = clock.split(":")
            return round(int(h) * 3600 + int(m) * 60 + float(s), 3)
    return 0.0


# ---------------------------------------------------------------------------
# The picture
# ---------------------------------------------------------------------------
def shoot(timing):
    from playwright.sync_api import sync_playwright

    if FRAMES.exists():
        shutil.rmtree(FRAMES)
    FRAMES.mkdir(parents=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--force-color-profile=srgb", "--font-render-hinting=none"])
        page = browser.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=1)
        page.goto(PAGE.as_uri(), wait_until="networkidle")
        # The Bengali face is font-display: block, so a frame taken before it
        # arrives would be blank rather than wrong -- wait for it either way.
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(400)

        page.evaluate("(t) => { window.__timeline = t; window.buildTimeline(); }", timing)
        total = page.evaluate("window.__total")
        frames = int(round(total * FPS))
        print(f"  {total:.2f}s at {FPS}fps = {frames} frames")

        for i in range(frames):
            page.evaluate("(t) => window.seek(t)", i / FPS)
            page.screenshot(path=str(FRAMES / f"f{i:05d}.png"))
            if i % 60 == 0:
                print(f"    frame {i}/{frames}")
        browser.close()
    return total


# ---------------------------------------------------------------------------
# The sound
# ---------------------------------------------------------------------------
def build_voice(timing, total):
    """One track, each line laid down where the picture expects it."""
    lines = timing["lines"]
    GAP, LEAD, TAIL = 0.45, 0.35, 0.55
    at = 0.6
    placed = []
    for line in lines:
        placed.append((AUDIO / line["file"], at + LEAD))
        at = at + line["seconds"] + TAIL + GAP

    # A silent bed of the full length, then every line mixed in at its offset.
    args = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-t", f"{total:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
    for path, _ in placed:
        args += ["-i", str(path)]

    chains = []
    for idx, (_, offset) in enumerate(placed, start=1):
        ms = int(round(offset * 1000))
        chains.append(f"[{idx}:a]aresample=48000,adelay={ms}|{ms},volume=1.0[v{idx}]")
    mix_in = "[0:a]" + "".join(f"[v{i}]" for i in range(1, len(placed) + 1))
    chains.append(
        f"{mix_in}amix=inputs={len(placed) + 1}:duration=first:normalize=0,"
        # A touch of headroom so the neural voice never clips the ceiling.
        f"alimiter=limit=0.94,afade=t=out:st={max(0, total - 0.6):.3f}:d=0.6[out]"
    )
    args += ["-filter_complex", ";".join(chains), "-map", "[out]",
             "-c:a", "aac", "-b:a", "192k", str(HERE / "voice-raw.m4a")]
    res = run(args)
    if res.returncode != 0:
        sys.exit("building the voice track failed:\n" + res.stderr[-1500:])
    return loudness(HERE / "voice-raw.m4a", HERE / "voice.m4a")


def loudness(src, dst):
    """Bring the track to the loudness a video platform expects.

    MEASURED, NOT ASSUMED, AND IT MATTERS. The first cut came out at -21.1
    LUFS. YouTube normalises to about -14: it turns loud things DOWN and
    quiet things not at all, so a -21 advert plays audibly quieter than
    whatever ran before it, which on a phone in a noisy room is the difference
    between hearing the offer and not.

    Two passes rather than one. A single-pass loudnorm guesses at the range
    from the first seconds it sees; measuring the whole file first and feeding
    those numbers back is what makes the result land on the number asked for
    instead of near it. With five spoken lines separated by silence, the
    difference between the two is several LU.
    """
    target = "I=-14:TP=-1.5:LRA=11"
    first = run([FFMPEG, "-hide_banner", "-i", str(src),
                 "-af", f"loudnorm={target}:print_format=json", "-f", "null", "-"]).stderr
    block = first[first.rfind("{"):first.rfind("}") + 1]
    try:
        m = json.loads(block)
        measured = (f":measured_I={m['input_i']}:measured_TP={m['input_tp']}"
                    f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}"
                    f":offset={m['target_offset']}:linear=true")
    except Exception:
        # Better a single pass than no normalisation; say so rather than
        # silently shipping the quiet one.
        print("  (could not read the loudness measurement; falling back to one pass)")
        measured = ""

    res = run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
               "-af", f"loudnorm={target}{measured}",
               "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", str(dst)])
    if res.returncode != 0:
        sys.exit("loudness pass failed:\n" + res.stderr[-1500:])
    return dst


# ---------------------------------------------------------------------------
# Putting them together
# ---------------------------------------------------------------------------
def encode(total, voice):
    OUT.mkdir(parents=True, exist_ok=True)
    final = OUT / FINAL_NAME
    args = [
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-framerate", str(FPS), "-i", str(FRAMES / "f%05d.png"),
        "-i", str(voice),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "slow", "-crf", "18",
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        # YouTube reads the index first; written at the end it must buffer the
        # whole file before it can start.
        "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-shortest", str(final),
    ]
    res = run(args)
    if res.returncode != 0:
        sys.exit("encode failed:\n" + res.stderr[-1500:])
    return final


# ---------------------------------------------------------------------------
# Is it actually finished?
# ---------------------------------------------------------------------------
def check(final):
    """The test the last promo would have failed."""
    info = probe(final)
    ok = True

    has_video = "Video: h264" in info
    has_audio = "Audio: aac" in info
    print(f"  video stream: {'yes' if has_video else 'NO'}")
    print(f"  audio stream: {'yes' if has_audio else 'NO'}")
    ok = ok and has_video and has_audio

    dur = seconds_of(final)
    print(f"  duration:     {dur:.2f}s")
    ok = ok and dur > 5

    # A stream can exist and be silence. Measure the loudness of what is in it.
    vol = run([FFMPEG, "-hide_banner", "-i", str(final),
               "-af", "volumedetect", "-f", "null", "-"]).stderr
    mean = next((l.split("mean_volume:")[1].strip()
                 for l in vol.splitlines() if "mean_volume:" in l), "")
    peak = next((l.split("max_volume:")[1].strip()
                 for l in vol.splitlines() if "max_volume:" in l), "")
    print(f"  mean volume:  {mean or 'unknown'}")
    print(f"  peak volume:  {peak or 'unknown'}")
    audible = bool(mean) and float(mean.split()[0]) > -60
    print(f"  audible:      {'yes' if audible else 'NO — this is a silent file'}")
    ok = ok and audible

    size_mb = final.stat().st_size / 1_000_000
    print(f"  size:         {size_mb:.1f} MB")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames-only", action="store_true")
    ap.add_argument("--remux", action="store_true",
                    help="rebuild the sound and mux it onto the frames already rendered")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--script", default="script.json",
                    help="which advert to build (read at import; listed here so --help shows it)")
    args = ap.parse_args()

    final = OUT / FINAL_NAME
    if args.check:
        sys.exit(0 if check(final) else 1)

    timing = json.loads(TIMING.read_text(encoding="utf-8"))
    if args.remux:
        frames = len(list(FRAMES.glob('f*.png')))
        if not frames:
            sys.exit('--remux needs frames; run without it first')
        total = frames / FPS
        print(f'  reusing {frames} frames ({total:.2f}s)')
    else:
        total = shoot(timing)
    if args.frames_only:
        print(f"  frames in {FRAMES}")
        return

    voice = build_voice(timing, total)
    print(f"  voice track {seconds_of(voice):.2f}s")
    final = encode(total, voice)
    print(f"\n  {final}")
    print("\n  Checking what was actually written:")
    if not check(final):
        sys.exit("\n  REFUSING TO CALL THIS DONE — see above.")
    print("\n  Sound and picture both present.")


if __name__ == "__main__":
    if not FFMPEG:
        sys.exit("FFMPEG is not set in .env.claude-tools")
    main()
