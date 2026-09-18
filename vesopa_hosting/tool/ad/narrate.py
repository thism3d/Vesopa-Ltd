"""Speak the advert's Bangla, one file per line, and write down how long each took.

    python tool/ad/narrate.py

THE PICTURE IS CUT TO THE VOICE, NOT THE OTHER WAY ROUND. A line of Bangla is
not the length you guess it is -- the same sentence runs a second longer than
its English -- so this runs first and writes `timing.json`, and the renderer
reads that to decide when each scene starts and how long it holds. Guessing the
durations and hoping is how a caption ends up a beat behind the word it belongs
to for the whole advert.

The voice is Microsoft's bn-BD neural pair through edge-tts. Gemini was the
intention and Gemini is out of credit -- every call answers 429 "Your
prepayment credits are depleted" -- so this is the working Bangladeshi voice,
chosen by the owner from a sample of both.

Each line is synthesised on its own rather than as one long take. It costs an
extra request and buys two things: a gap between lines that the edit controls
rather than the synthesiser, and the ability to re-record one sentence without
re-cutting the whole advert.
"""

import asyncio
import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]

# Which advert. A second format is a second script file, not a second copy of
# this: the vertical cut says the same things in a different shape, and two
# narrators that drift apart is how a caption ends up a beat behind the word.
#   python tool/ad/narrate.py --script script-vertical.json
_args = [a for a in sys.argv[1:] if not a.startswith("-")]
if "--script" in sys.argv:
    _name = sys.argv[sys.argv.index("--script") + 1]
else:
    _name = "script.json"
SCRIPT = json.loads((HERE / _name).read_text(encoding="utf-8"))
OUT = HERE / SCRIPT.get("audio", "audio")
TIMING = HERE / SCRIPT.get("timing", "timing.json")

# The repo keeps the ffmpeg path with the other tool settings.
FFMPEG = ""
for raw in (ROOT / ".env.claude-tools").read_text(encoding="utf-8").splitlines():
    if raw.startswith("FFMPEG="):
        FFMPEG = raw.split("=", 1)[1].strip().strip('"').strip("'")


def duration(path):
    """Seconds, read back off the file rather than assumed from the text."""
    out = subprocess.run(
        [FFMPEG, "-hide_banner", "-i", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    ).stderr
    for token in out.split():
        pass
    for line in out.splitlines():
        if "Duration:" in line:
            clock = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = clock.split(":")
            return round(int(h) * 3600 + int(m) * 60 + float(s), 3)
    raise SystemExit(f"ffmpeg did not report a duration for {path}:\n{out[-800:]}")


async def main():
    import edge_tts

    OUT.mkdir(parents=True, exist_ok=True)
    timing = {"voice": SCRIPT["voice"], "lines": []}

    for line in SCRIPT["lines"]:
        path = OUT / f"{line['id']}.mp3"
        speech = edge_tts.Communicate(line["say"], SCRIPT["voice"], rate=SCRIPT.get("rate", "+0%"))
        await speech.save(str(path))
        secs = duration(path)
        timing["lines"].append({
            "id": line["id"],
            "show": line["show"],
            "say": line["say"],
            "file": path.name,
            "seconds": secs,
        })
        # The Windows console here is cp1252 and raises on Bangla, which would
        # throw away a synthesis that had already succeeded. The line is
        # reported by id and length instead, and the text itself is in the
        # script and in timing.json for anybody who wants to read it.
        print(f"  {line['id']:<9} {secs:>6.2f}s  {len(line['say']):>3} characters")

    total = sum(l["seconds"] for l in timing["lines"])
    timing["spoken_seconds"] = round(total, 3)
    TIMING.write_text(json.dumps(timing, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  {len(timing['lines'])} lines, {total:.2f}s of speech before gaps.")


if __name__ == "__main__":
    if not FFMPEG:
        sys.exit("FFMPEG is not set in .env.claude-tools")
    asyncio.run(main())
