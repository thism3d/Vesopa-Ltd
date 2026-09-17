"""Check the Bangla ears: continuous, patient, and interruptible.

    python tool/cloud_ai_bangla_ears_test.py

Bangla is heard by the BROWSER's recogniser, because the server's voice model
cannot do Bengali (measured 2026-09-17, see src/ai/bedrock.js). This machine
has no microphone and Google's recogniser cannot be driven from here, so the
recogniser is replaced with a stub that records what the widget asked it for
and plays back words on a schedule.

What that proves is the widget's own half, which is where the owner's
complaints live:

  asked for       continuous recognition, not Chrome's one-second endpoint
                  ("stopping before I finish taking"), and bn-BD
  patient         a 1.5s pause in the middle of a sentence does NOT end the
                  turn; both halves arrive as one message
  interruptible   words heard while the assistant is speaking stop it, and the
                  turn is marked as an interruption
  not its own     the assistant's own sentence coming back through a
                  loudspeaker does NOT count as an interruption

It does not prove Google's Bengali recognition itself; nothing here can.
"""

import datetime
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://cloud.vesopa.com").rstrip("/")
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images"
STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")

STUB = r"""
(() => {
  window.__vaiRec = { made: [], started: 0 };
  class FakeRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; }
    start() {
      window.__vaiRec.made.push({ lang: this.lang, continuous: this.continuous, interim: this.interimResults });
      window.__vaiRec.started += 1;
      window.__vaiRecCurrent = this;
    }
    stop() { if (this.onend) this.onend({}); }
    abort() { if (this.onend) this.onend({}); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;

  // Say a phrase to the widget as the recogniser would.
  window.__vaiSay = (text, isFinal) => {
    const rec = window.__vaiRecCurrent;
    if (!rec || !rec.onresult) return false;
    const results = [[{ transcript: text }]];
    results[0].isFinal = !!isFinal;
    results.length = 1;
    rec.onresult({ resultIndex: 0, results: Object.assign(results, { length: 1 }) });
    return true;
  };

  // A voice that takes its time, so there is something to talk over.
  const fake = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [{ name: 'Test', lang: 'bn-BD', default: true, localService: true, voiceURI: 't' }],
    speak(u) {
      fake.speaking = true;
      window.__vaiSpoken = window.__vaiSpoken || [];
      window.__vaiSpoken.push(String(u.text || ''));
      setTimeout(() => { fake.speaking = false; if (u.onend) u.onend({}); }, 8000);
    },
    cancel() { fake.speaking = false; window.__vaiCancelled = (window.__vaiCancelled || 0) + 1; },
    pause() {}, resume() {}, addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { get: () => fake, configurable: true });
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  // No real microphone on this machine.
  navigator.mediaDevices.getUserMedia = () => Promise.resolve(new MediaStream());
})();
"""


def safe(page, expr, arg=None):
    """A navigation mid-test (the assistant may open a page) must not end it."""
    for _ in range(3):
        try:
            return page.evaluate(expr, arg) if arg is not None else page.evaluate(expr)
        except Exception:
            page.wait_for_timeout(800)
    return None


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    posts = []
    report = {"base": BASE, "posts": posts}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--use-fake-ui-for-media-stream"])
        ctx = browser.new_context(permissions=["microphone"], bypass_csp=True, viewport={"width": 1280, "height": 900})
        ctx.add_init_script(STUB)
        page = ctx.new_page()

        def on_request(req):
            if req.url.endswith("/ai/turn") and req.method == "POST":
                try:
                    body = req.post_data_json or {}
                except Exception:
                    body = {}
                posts.append({"text": body.get("text") or "", "lang": body.get("lang"), "interrupted": bool(body.get("interrupted"))})

        replies = []
        report["replies"] = replies

        def on_response(res):
            if res.url.endswith("/ai/turn"):
                try:
                    body = res.json()
                except Exception:
                    return
                replies.append({"say": (body.get("say") or "")[:160], "voice_lines": bool(body.get("speak")), "silence": bool(body.get("silence")), "error": body.get("error")})

        page.on("request", on_request)
        page.on("response", on_response)
        page.goto(f"{BASE}/", wait_until="domcontentloaded")
        page.wait_for_selector("#vai .vai-orb", state="visible", timeout=20000)
        page.wait_for_timeout(1500)

        # Bangla, then voice on.
        safe(page, "() => { const s = JSON.parse(localStorage.getItem('vesopa_ai_v1') || '{}'); s.lang = 'bn'; s.voice = true; localStorage.setItem('vesopa_ai_v1', JSON.stringify(s)); }")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("#vai .vai-orb", state="visible", timeout=20000)
        page.wait_for_timeout(1500)
        # The tap can land while the widget is still settling (it says hello,
        # and may open a page), so it is tried until the ears actually start.
        made = []
        for attempt in range(4):
            try:
                page.click("#vai .vai-orb", timeout=5000)
            except Exception:
                pass
            page.wait_for_timeout(1500)
            made = safe(page, "() => (window.__vaiRec && window.__vaiRec.made) || []") or []
            if made:
                break
            # An odd number of taps would leave voice off again.
            page.wait_for_timeout(500)
        report["asked_for"] = made
        report["taps"] = attempt + 1
        if not made:
            raise SystemExit("the recogniser never started -- voice did not switch on")
        page.screenshot(path=str(SHOTS / f"ai-bangla-{STAMP}-1-voice-on.png"))

        # A sentence with a real pause in the middle of it.
        safe(page, "() => window.__vaiSay('আমার domain', true)")
        page.wait_for_timeout(1500)                       # the thinking pause
        before = len(posts)
        report["sent_during_pause"] = before
        safe(page, "() => window.__vaiSay('টা available কিনা দেখেন', true)")
        page.wait_for_timeout(3200)                       # past END_MS
        report["after_pause"] = list(posts)

        # While it speaks: first its own words back (must be ignored), then the
        # customer's (must interrupt). Wait until it is ACTUALLY speaking --
        # a fixed pause raced the reply and proved nothing half the time.
        # The first entry is the silent unlock utterance, so a real line is
        # anything with words in it.
        spoken = []
        for _ in range(30):
            spoken = [t for t in (safe(page, "() => window.__vaiSpoken || []") or []) if t.strip()]
            if spoken:
                break
            page.wait_for_timeout(700)
        report["spoken"] = spoken
        report["waited_for_speech"] = bool(spoken)
        echo = (spoken or [""])[0][:40]
        if echo:
            safe(page, "(t) => window.__vaiSay(t, true)", echo)
            page.wait_for_timeout(1200)
        report["state_while_speaking"] = safe(page, "() => document.querySelector('#vai .vai-orb').getAttribute('data-state')")
        # A cancel alone proves nothing -- every turn calls stopSpeaking. What
        # proves the echo was ignored is that it started no turn of its own.
        report["turns_after_echo"] = len(posts)
        safe(page, "() => window.__vaiSay('না থামেন আমি অন্য কথা বলছি', true)")
        page.wait_for_timeout(3500)
        report["turns_after_customer"] = len(posts)
        report["posts_final"] = list(posts)
        report["messages"] = safe(page, "() => Array.from(document.querySelectorAll('#vai .vai-msg')).map(e => e.className + ': ' + e.textContent.trim()).slice(0, 12)") or []
        page.screenshot(path=str(SHOTS / f"ai-bangla-{STAMP}-2-end.png"))
        ctx.close()
        browser.close()

    out = SHOTS / f"ai-bangla-{STAMP}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("written to", out)
    print("asked for:", json.dumps(report.get("asked_for")))
    print("sent during the pause (want 0):", report.get("sent_during_pause"))
    print("turns:", json.dumps(report.get("posts_final"))[:600])
    echo_turns = report.get("turns_after_echo")
    print("turns after its own echo came back (want the same count, it is ignored):", echo_turns)
    print("turns after the customer spoke over it (want one more):", report.get("turns_after_customer"))
    interrupted = [p for p in (report.get("posts_final") or []) if p.get("interrupted")]
    print("turns marked as an interruption (want 1):", len(interrupted))


if __name__ == "__main__":
    for attempt in range(3):
        try:
            main()
            break
        except SystemExit:
            raise
        except Exception as err:
            # Most often: the assistant navigated, which reloads the widget
            # with voice off. Nothing is proved either way; run it again.
            print(f"attempt {attempt + 1} ended early ({str(err)[:80]}), trying again")
    else:
        raise SystemExit("could not complete a run without the page navigating")
