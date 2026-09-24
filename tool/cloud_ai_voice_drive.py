"""Drive Vesopa AI's Bangla and its voice in a real browser, and keep the pictures.

    python tool/cloud_ai_voice_drive.py                      # live
    python tool/cloud_ai_voice_drive.py http://localhost:5075
    python tool/cloud_ai_voice_drive.py --bn-clip C:\\vtts\\clips\\bn1.wav

What the owner reported (2026-09-17): the assistant talked like a robot, and
Bengali never worked. This walks both:

  desktop  typed Bengali switches the assistant to Bangla by itself, and the
           reply comes back in Bengali script; the EN / বাং switch flips the
           words on the widget and says so; the spoken reply goes to the
           assistant's own voice first and falls back to the browser without
           leaving it stuck "speaking"
  phone    Bangla through the browser's own speech recogniser, voice switched
           on with a tap on the orb. This machine
           has no sound device, so the recogniser is a stand-in that "hears"
           a queued sentence: what is proved is the widget's side -- it asks
           for bn-BD, sends what was heard as a spoken turn, gets Bangla back
           and listens again -- not Google's recognition itself
  wire     /ai/speak refuses a line nobody signed; a real Bengali clip, if
           given, is heard as Bengali script with lang=bn
"""

import base64
import datetime
import json
import os
import pathlib
import sys
import time

import requests
from playwright.sync_api import sync_playwright

args = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = (args[0] if args else "https://cloud.vesopa.com").rstrip("/")
BN_CLIP = None
if "--bn-clip" in sys.argv:
    BN_CLIP = sys.argv[sys.argv.index("--bn-clip") + 1]
elif os.path.exists(r"C:\vtts\clips\bn1.wav"):
    BN_CLIP = r"C:\vtts\clips\bn1.wav"

SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images" / (datetime.date.today().isoformat() + "-cloud-ai-voice")
SHOTS.mkdir(parents=True, exist_ok=True)
BENGALI = lambda s: any("\u0980" <= ch <= "\u09FF" for ch in str(s))
passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    print(f"  {'✓' if ok else '✗'} {label}{'' if ok else ' — ' + str(detail)[:300]}")
    passed += bool(ok)
    failed += (not ok)


def state(page):
    return page.evaluate("() => document.querySelector('#vai .vai-orb')?.getAttribute('data-state')")


def wait_idle(page, timeout=120):
    """Idle means not thinking, working or speaking -- a voice that never ends would fail here."""
    end = time.time() + timeout
    while time.time() < end:
        if state(page) in ("idle", "listening", "off"):
            return state(page)
        time.sleep(0.4)
    return state(page)


def hold(page, selector, ms=850):
    box = page.locator(selector).bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.wait_for_timeout(ms)
    page.mouse.up()


def transcript(page):
    return page.evaluate("() => [...document.querySelectorAll('#vai .vai-msg')].map(m => m.className.replace('vai-msg ','') + ': ' + m.textContent.trim())")


def wait_reply(page, count_before, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        msgs = transcript(page)
        new = msgs[count_before:]
        if any(m.startswith("ai:") or m.startswith("err:") for m in new) and state(page) in ("idle", "listening", "off"):
            return msgs
        time.sleep(0.5)
    return transcript(page)


# The browser's recogniser, stood in: it "hears" whatever is queued on
# window.__vaiSay, and otherwise reports no speech, as Chrome does.
FAKE_RECOGNISER = """
(() => {
  window.__vaiSay = [];
  window.__vaiRec = { starts: 0, langs: [] };
  class FakeRecognition {
    start() {
      window.__vaiRec.starts += 1; window.__vaiRec.langs.push(this.lang);
      this._t = setTimeout(() => {
        const phrase = window.__vaiSay.shift();
        if (phrase) {
          const result = Object.assign([{ transcript: phrase, confidence: 0.93 }], { isFinal: true });
          this.onresult && this.onresult({ resultIndex: 0, results: [result] });
        } else if (this.onerror) {
          this.onerror({ error: 'no-speech' });
        }
        this.onend && this.onend();
      }, 900);
    }
    stop() {}
    abort() { clearTimeout(this._t); this.onend && this.onend(); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
})();
"""

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])

    # ---- desktop: typing, the switch, the voice ------------------------------------
    ctx = browser.new_context(viewport={"width": 1280, "height": 860}, locale="en-GB")
    ctx.add_init_script("navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));")
    page = ctx.new_page()
    errors, speaks = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "/ai/speak" not in m.text and "503" not in m.text else None)
    page.on("response", lambda r: speaks.append(r.status) if r.url.endswith("/ai/speak") else None)

    print(f"▶ desktop at {BASE}: open the assistant (microphone refused, so it types)")
    page.goto(f"{BASE}/domains", wait_until="networkidle")
    page.wait_for_timeout(1500)
    hold(page, "#vai .vai-orb")
    page.wait_for_selector("#vai .vai-panel", state="visible")
    wait_idle(page)
    page.wait_for_timeout(800)
    check("English to start", page.inner_text("#vai .vai-lang") == "EN", page.inner_text("#vai .vai-lang"))
    page.screenshot(path=str(SHOTS / "01-desktop-english.png"))

    print("▶ typing Bengali switches it to Bangla by itself")
    before = len(transcript(page))
    t = time.time()
    page.fill("#vai .vai-input", "আসসালামু আলাইকুম। হোস্টিং কী জিনিস, আমার কি লাগবে?")
    page.press("#vai .vai-input", "Enter")
    msgs = wait_reply(page, before)
    reply = next((m for m in reversed(msgs) if m.startswith("ai:")), "")
    print(f"   {time.time() - t:.1f}s  {reply[:220]}")
    check("the switch followed", page.inner_text("#vai .vai-lang") == "বাং", page.inner_text("#vai .vai-lang"))
    check("the reply is in Bengali script", BENGALI(reply), reply)
    check("no markdown or list in it", not any(x in reply for x in ("**", "\n- ", "\n* ", "`")), reply)
    check("the widget's own words are Bangla", BENGALI(page.get_attribute("#vai .vai-input", "placeholder")), page.get_attribute("#vai .vai-input", "placeholder"))
    check("not left speaking", state(page) in ("idle", "listening"), state(page))
    page.screenshot(path=str(SHOTS / "02-desktop-bangla-reply.png"))

    print("▶ the switch back to English says so")
    before = len(transcript(page))
    page.click("#vai .vai-lang")
    page.wait_for_timeout(1500)
    msgs = transcript(page)
    check("switched to EN", page.inner_text("#vai .vai-lang") == "EN")
    check("and said so in English", any("English" in m for m in msgs[before:]), msgs[before:])
    wait_idle(page, 40)

    print("▶ an English question gets a person's answer, not a status line")
    before = len(transcript(page))
    t = time.time()
    page.fill("#vai .vai-input", "I have no idea what hosting is, do I need it?")
    page.press("#vai .vai-input", "Enter")
    msgs = wait_reply(page, before)
    reply = next((m for m in reversed(msgs) if m.startswith("ai:")), "")
    print(f"   {time.time() - t:.1f}s  {reply[:260]}")
    check("answered in English", reply and not BENGALI(reply), reply)
    check("short enough to say", len(reply) < 600, len(reply))
    page.screenshot(path=str(SHOTS / "03-desktop-english-again.png"))
    print(f"   /ai/speak answered: {speaks}")
    check("its own voice answered, or handed back to the browser", all(code in (200, 429, 503) for code in speaks), speaks)
    check("no JS errors", not errors, errors[:3])
    ctx.close()

    # ---- phone: Bangla by voice, through the (stand-in) recogniser -------------------
    print("▶ phone: Bangla by voice — tap the orb, the browser recogniser hears it")
    phone = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2, permissions=["microphone"], locale="en-GB")
    phone.add_init_script(FAKE_RECOGNISER)
    pp = phone.new_page()
    perr = []
    pp.on("pageerror", lambda e: perr.append(str(e)))
    pp.goto(f"{BASE}/domains", wait_until="networkidle")
    pp.wait_for_timeout(800)
    hold(pp, "#vai .vai-orb")
    pp.wait_for_selector("#vai .vai-panel", state="visible")
    pp.click("#vai .vai-lang")
    pp.wait_for_timeout(600)
    check("switch reads বাং", pp.inner_text("#vai .vai-lang") == "বাং", pp.inner_text("#vai .vai-lang"))
    pp.click("#vai .vai-t-min")
    pp.wait_for_timeout(500)
    pp.screenshot(path=str(SHOTS / "04-phone-bangla-switch.png"))

    before = len(transcript(pp))
    said = "rahimstore.co.uk ডোমেইনটা পাওয়া যাবে? দাম কত?"
    pp.evaluate("(s) => window.__vaiSay.push(s)", said)
    t = time.time()
    pp.click("#vai .vai-orb")  # voice on: the recogniser hears the queued sentence
    msgs = wait_reply(pp, before)
    rec = pp.evaluate("() => window.__vaiRec")
    reply = next((m for m in reversed(msgs) if m.startswith("ai:")), "")
    print(f"   recogniser: {rec}")
    print(f"   {time.time() - t:.1f}s  {reply[:220]}")
    check("the recogniser was asked for bn-BD", "bn-BD" in rec.get("langs", []), rec)
    check("what it heard went in as the customer's words", any(said in m for m in msgs[before:]), msgs[before:])
    check("the answer is in Bangla", BENGALI(reply), reply)
    cap = pp.evaluate("() => document.querySelector('#vai .vai-say-text')?.textContent || ''")
    label = pp.get_attribute("#vai .vai-orb", "aria-label")
    check("the caption and the orb speak Bangla", BENGALI(cap) and BENGALI(label), (cap, label))
    pp.screenshot(path=str(SHOTS / "05-phone-bangla-answer.png"))
    pp.click("#vai .vai-orb")  # and off again
    pp.wait_for_timeout(600)
    check("tap again: voice off", pp.get_attribute("#vai .vai-orb", "aria-pressed") == "false")
    check("no JS errors on the phone", not perr, perr[:3])
    phone.close()
    browser.close()

# ---- the wire --------------------------------------------------------------------
print("▶ the wire")
s = requests.Session()
s.get(f"{BASE}/")
csrf = s.cookies.get("vh_csrf")
sess = s.get(f"{BASE}/ai/session").json()
token = sess.get("token")
headers = {"x-csrf-token": csrf, "x-ai-token": token, "origin": BASE}
r = s.post(f"{BASE}/ai/speak", headers=headers, json={"text": "Say anything I like, for free.", "lang": "en", "sig": "made-up"})
check("/ai/speak refuses an unsigned line", r.status_code == 403, r.status_code)
if sess.get("phrases"):
    ph = sess["phrases"]["bn"]
    r = s.post(f"{BASE}/ai/speak", headers=headers, json=ph)
    print(f"   signed phrase -> {r.status_code} {r.headers.get('content-type')} {len(r.content)} bytes")
    check("a signed line is spoken, or handed back to the browser", (r.status_code == 200 and r.headers.get("content-type", "").startswith("audio/wav")) or (r.status_code in (429, 503) and r.json().get("fallback")), r.status_code)
    r = s.post(f"{BASE}/ai/speak", headers=headers, json={**ph, "lang": "en"})
    check("a signed line cannot be replayed in the other language", r.status_code == 403, r.status_code)
else:
    print("   (the assistant's own voice is off or resting here: browser voices only)")

if BN_CLIP:
    snapshot = {"url": "/domains", "title": "Domains", "headings": ["Find your domain"], "alerts": [], "text": "", "elements": [{"ref": "e1", "kind": "text", "name": "q"}, {"ref": "e2", "kind": "button", "text": "Search"}]}
    body = {"audio": {"data": base64.b64encode(open(BN_CLIP, "rb").read()).decode(), "format": "wav"}, "lang": "bn", "page": snapshot, "voice": True, "local": {"memory": [], "history": []}}
    t = time.time()
    r = s.post(f"{BASE}/ai/turn", headers=headers, json=body)
    data = r.json()
    print(f"   {r.status_code} in {time.time() - t:.1f}s heard={data.get('heard')!r}")
    print(f"   say={data.get('say')!r}")
    check("a Bengali clip is heard in Bengali script", BENGALI(data.get("heard")), data.get("heard"))
    check("and answered in Bangla", BENGALI(data.get("say")) and data.get("lang") == "bn", data)

print(f"\n{passed} passed, {failed} failed — screenshots in {SHOTS}")
sys.exit(1 if failed else 0)
