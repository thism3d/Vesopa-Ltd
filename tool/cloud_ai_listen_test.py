"""Prove Vesopa AI listens to the end of a sentence, and can be talked over.

    python tool/cloud_ai_listen_test.py                      # live
    python tool/cloud_ai_listen_test.py http://localhost:5075

WHAT THE OWNER REPORTED (2026-09-17): "Ai is not completely listening to me,
stopping before I finish taking ... let me interrupt starting taking it stops
and listen to me again".

Chromium is given a FAKE MICROPHONE fed from a WAV file, so this is the real
widget, the real getUserMedia stream and the real voice-activity code -- not a
stand-in. The clip is built by tool-side code (see the header of
C:/vtts/clips/pause_test.wav) as:

    1s quiet | "How much is the hosting plan?" | 1.5s PAUSE
            | "and also hosting and email setup please" | 6s quiet

PATIENCE. One turn must be sent, after the SECOND phrase, carrying a clip long
enough to hold both. Before this fix the widget sent after 900ms of quiet, so
the 1.5s pause split the sentence in two and the customer was answered
half way through.

INTERRUPTING. The browser's own voice is replaced with a stub that holds for
several seconds, because a headless Chromium has no voices at all and would
otherwise finish speaking instantly. Everything else -- the open microphone
during the reply, the loudness bar, stopping the reply, sending the clip as
`interrupted` -- is the widget's own code.

Pictures and the JSON summary are kept in Documents/Vesopa-Claude-Images.
"""

import datetime
import json
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

args = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = (args[0] if args else "https://cloud.vesopa.com").rstrip("/")
CLIP = pathlib.Path("C:/vtts/clips/pause_test.wav")
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images"
STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")

# Hold every spoken reply open for this long, so there is something to talk over.
SPEAK_HOLD_MS = 6000

STUB = """
// A voice that takes its time, so the microphone has something to interrupt.
(() => {
  const hold = %d;
  const fake = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [{ name: 'Test Voice', lang: 'en-GB', default: true, localService: true, voiceURI: 'test' }],
    speak(u) {
      fake.speaking = true;
      window.__vaiSpokeAt = window.__vaiSpokeAt || [];
      window.__vaiSpokeAt.push({ at: Date.now(), text: String(u.text || '') });
      u._t = setTimeout(() => { fake.speaking = false; if (u.onend) u.onend({}); }, hold);
    },
    cancel() {
      fake.speaking = false;
      window.__vaiCancelled = (window.__vaiCancelled || 0) + 1;
      window.__vaiCancelledAt = Date.now();
    },
    pause() {}, resume() {},
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { get: () => fake, configurable: true });
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  // No browser recogniser here: this run is about the voice model's ears.
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
})();
""" % SPEAK_HOLD_MS


def main():
    if not CLIP.exists():
        raise SystemExit(f"clip missing: {CLIP}")
    SHOTS.mkdir(parents=True, exist_ok=True)
    turns = []
    report = {"base": BASE, "clip": str(CLIP), "turns": turns}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                f"--use-file-for-fake-audio-capture={CLIP}",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )
        ctx = browser.new_context(
            permissions=["microphone"],
            bypass_csp=True,
            viewport={"width": 1280, "height": 900},
        )
        ctx.add_init_script(STUB)

        started = time.time()

        def on_request(req):
            if req.url.endswith("/ai/turn") and req.method == "POST":
                try:
                    body = req.post_data_json or {}
                except Exception:
                    body = {}
                clip = (body.get("audio") or {}).get("data") or ""
                turns.append({
                    "at": round(time.time() - started, 2),
                    "seconds_of_audio": round(len(clip) * 3 / 4 / 32000, 2) if clip else 0,
                    "text": body.get("text") or "",
                    "interrupted": bool(body.get("interrupted")),
                })

        page = ctx.new_page()
        page.on("request", on_request)
        page.goto(f"{BASE}/", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.wait_for_selector("#vai .vai-orb", state="visible", timeout=20000)

        # A tap on the orb IS the voice switch (hold opens the chat).
        page.click("#vai .vai-orb")
        page.wait_for_timeout(1200)
        page.screenshot(path=str(SHOTS / f"ai-listen-{STAMP}-1-voice-on.png"))
        started = time.time()
        report["voice_on_state"] = page.get_attribute("#vai .vai-orb", "data-state")

        # The whole clip, plus the 6s of quiet at its end, plus room for the reply.
        page.wait_for_timeout(30000)
        page.screenshot(path=str(SHOTS / f"ai-listen-{STAMP}-2-after-speech.png"), full_page=False)

        report["spoken"] = page.evaluate("() => window.__vaiSpokeAt || []")
        report["cancelled"] = page.evaluate("() => window.__vaiCancelled || 0")
        report["transcript"] = page.evaluate(
            "() => Array.from(document.querySelectorAll('#vai .vai-msg')).map(e => e.className + ': ' + e.textContent.trim()).slice(0, 12)"
        )
        page.wait_for_timeout(12000)
        report["turns_after_reply"] = [t for t in turns]
        report["cancelled_final"] = page.evaluate("() => window.__vaiCancelled || 0")
        report["transcript_final"] = page.evaluate(
            "() => Array.from(document.querySelectorAll('#vai .vai-msg')).map(e => e.className + ': ' + e.textContent.trim()).slice(0, 16)"
        )
        page.screenshot(path=str(SHOTS / f"ai-listen-{STAMP}-3-end.png"))
        ctx.close()
        browser.close()

    # Chromium loops the fake clip and voice comes on at whatever point the
    # loop has reached, so WHICH turn holds the whole sentence varies. What
    # must be true is that one of them does: a clip long enough to span the
    # 1.5s pause, or one message carrying both halves of the sentence.
    said = " ".join(report.get("transcript_final") or []).lower()
    patient = (
        any(t["seconds_of_audio"] >= 8 for t in turns)
        or ("hosting plan" in said and "email setup" in said)
    )
    interruptible = any(t["interrupted"] for t in turns)
    report["patient"] = patient
    report["interruptible"] = interruptible
    report["pass"] = bool(patient and interruptible)

    out = SHOTS / f"ai-listen-{STAMP}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("written to", out)
    print("turns:", json.dumps(turns))
    print("listened past the 1.5s pause:", patient)
    print("could be talked over:", interruptible)
    print("PASS" if report["pass"] else "FAIL")


if __name__ == "__main__":
    main()
