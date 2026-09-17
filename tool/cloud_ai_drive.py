"""Drive Vesopa AI on cloud.vesopa.com in a real browser, and keep the pictures.

    python tool/cloud_ai_drive.py [base-url]

As a visitor (nobody signed in):
  desktop  the orb is calm: nothing asks for the microphone at load, it
           introduces itself once a visit and goes quiet by itself. A tap asks
           for the microphone (refused here, so voice stays off and the caption
           says how to type); press and hold opens the chat, which checks a
           domain, puts it in the basket, and survives the router's page change
  phone    the microphone is granted (Chromium's fake device): tap is voice
           on, tap again is voice off with the microphone handed back, press
           and hold is the chat sheet
  wire     a spoken WAV (Windows' own voice) posted to /ai/turn the way the
           widget posts it, with the widget token; and the same call without
           the token, which must be refused
"""

import base64
import datetime
import json
import os
import pathlib
import subprocess
import sys
import time

import requests
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://cloud.vesopa.com").rstrip("/")
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images" / (datetime.date.today().isoformat() + "-cloud-ai")
SHOTS.mkdir(parents=True, exist_ok=True)
passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    print(f"  {'✓' if ok else '✗'} {label}{'' if ok else ' — ' + str(detail)[:300]}")
    passed += ok
    failed += (not ok)


def state(page):
    return page.evaluate("() => document.querySelector('#vai .vai-orb')?.getAttribute('data-state')")


def wait_idle(page, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        if state(page) in ("idle", "listening", "off"):
            return state(page)
        time.sleep(0.4)
    return state(page)


def hold(page, selector, ms=850):
    """Press and hold, the way a thumb does."""
    box = page.locator(selector).bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.wait_for_timeout(ms)
    page.mouse.up()


def pressed(page):
    return page.evaluate("() => document.querySelector('#vai .vai-orb')?.getAttribute('aria-pressed')")


def caption(page):
    return page.evaluate("() => { const s = document.querySelector('#vai .vai-say'); return s && !s.hidden ? s.textContent.trim() : ''; }")


def transcript(page):
    return page.evaluate("() => [...document.querySelectorAll('#vai .vai-msg')].map(m => m.className.replace('vai-msg ','') + ': ' + m.textContent.trim())")


with sync_playwright() as p:
    # A fake microphone, so the phone half can be granted one; the desktop
    # half refuses it by hand, to walk the other path.
    browser = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])

    # ---- desktop, microphone refused ----------------------------------------
    ctx = browser.new_context(viewport={"width": 1280, "height": 860})
    ctx.add_init_script("window.__micAsks = 0; navigator.mediaDevices.getUserMedia = () => { window.__micAsks += 1; return Promise.reject(new DOMException('denied', 'NotAllowedError')); };")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    print("▶ desktop: a calm orb that introduces itself once, then goes quiet")
    page.goto(f"{BASE}/", wait_until="networkidle")
    page.wait_for_timeout(2500)
    check("orb is there", page.locator("#vai .vai-orb").count() == 1)
    check("nothing asked for the microphone at load", page.evaluate("() => window.__micAsks") == 0, page.evaluate("() => window.__micAsks"))
    check("idle and voice off", state(page) == "idle" and pressed(page) == "false", (state(page), pressed(page)))
    check("it introduces itself", page.locator("#vai .vai-hello").count() == 1)
    page.screenshot(path=str(SHOTS / "01-orb-hello.png"))
    for _ in range(40):
        if page.locator("#vai .vai-hello").count() == 0:
            break
        time.sleep(0.5)
    check("and goes quiet by itself", page.locator("#vai .vai-hello").count() == 0)
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(2500)
    check("only once a visit", page.locator("#vai .vai-hello").count() == 0)

    print("▶ tap: voice on — the microphone is refused here")
    page.click("#vai .vai-orb")
    page.wait_for_timeout(1500)
    check("the tap asked for the microphone", page.evaluate("() => window.__micAsks") == 1, page.evaluate("() => window.__micAsks"))
    check("voice stays off", pressed(page) == "false", pressed(page))
    print("   caption:", caption(page)[:120])
    check("the caption says how to type instead", len(caption(page)) > 20, caption(page))
    page.screenshot(path=str(SHOTS / "02-mic-refused.png"))

    print("▶ press and hold opens the chat")
    hold(page, "#vai .vai-orb")
    page.wait_for_selector("#vai .vai-panel", state="visible", timeout=5000)
    page.wait_for_timeout(600)
    msgs = transcript(page)
    check("the chat says hello", any(m.startswith("ai:") for m in msgs), msgs)
    check("holding did not also toggle voice", page.evaluate("() => window.__micAsks") == 1, page.evaluate("() => window.__micAsks"))
    page.screenshot(path=str(SHOTS / "03-chat.png"))

    print("▶ check a domain and add it to the basket")
    page.fill("#vai .vai-input", "Is vesopa-ai-demo.co.uk available? If so add it to my basket.")
    page.press("#vai .vai-input", "Enter")
    wait_idle(page, 120)
    page.wait_for_timeout(1500)
    msgs = transcript(page)
    print("   " + "\n   ".join(msgs[-6:]))
    check("it answered", any(m.startswith("ai:") for m in msgs[-5:]), msgs[-3:])
    check("it acted on the page", any("Opening /cart" in m for m in msgs), "no basket action logged")
    try:
        page.wait_for_url("**/cart**", timeout=20000)
    except Exception:
        pass
    # The report comes on the automatic turn after the page changed.
    for _ in range(40):
        msgs = transcript(page)
        if msgs and msgs[-1].startswith("ai:") and "basket" in msgs[-1].lower():
            break
        time.sleep(1)
    print("   " + msgs[-1][:200])
    print("   now at", page.url)
    check("basket reached without a reload", "/cart" in page.url, page.url)
    check("it reported the basket", "basket" in msgs[-1].lower(), msgs[-1])
    page.screenshot(path=str(SHOTS / "04-basket.png"))

    print("▶ survives a page change (no-reload router)")
    before = len(transcript(page))
    page.evaluate("window.VesopaNav && window.VesopaNav.go('/hosting', true)")
    page.wait_for_timeout(2500)
    check("widget still mounted after navigation", page.locator("#vai .vai-panel").count() == 1)
    check("transcript kept", len(transcript(page)) >= before)
    page.screenshot(path=str(SHOTS / "05-after-nav.png"))

    print("▶ ask about plans on the hosting page")
    page.fill("#vai .vai-input", "Which plan is cheapest and what does it cost per month?")
    page.press("#vai .vai-input", "Enter")
    wait_idle(page, 120)
    page.wait_for_timeout(500)
    msgs = transcript(page)
    print("   " + msgs[-1][:300])
    check("answered with a price", any(c in msgs[-1] for c in "£$€") or "per month" in msgs[-1].lower(), msgs[-1])

    print("▶ minimise")
    page.click("#vai .vai-t-min")
    check("panel hidden, orb stays", page.locator("#vai .vai-panel").is_hidden() and page.locator("#vai .vai-orb").is_visible())
    page.screenshot(path=str(SHOTS / "06-minimised.png"))
    check("no JS errors", not errors, errors[:3])
    ctx.close()

    # ---- phone, microphone granted (fake device) -----------------------------
    print("▶ phone: tap for voice, tap again to stop, hold for the chat")
    phone = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2, permissions=["microphone"])
    phone.add_init_script("""(() => {
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__micAsks = 0; window.__streams = [];
      navigator.mediaDevices.getUserMedia = (c) => { window.__micAsks += 1; return real(c).then((s) => { window.__streams.push(s); return s; }); };
    })();""")
    pp = phone.new_page()
    perr = []
    pp.on("pageerror", lambda e: perr.append(str(e)))
    pp.goto(f"{BASE}/domains", wait_until="networkidle")
    pp.wait_for_timeout(2000)
    check("calm at load: no microphone", pp.evaluate("() => window.__micAsks") == 0 and pressed(pp) == "false")
    pp.screenshot(path=str(SHOTS / "07-phone-calm.png"))
    pp.click("#vai .vai-orb")
    # The microphone is granted asynchronously, and on live the fake device
    # took longer than a fixed 2 s once; wait for voice to come on.
    for _ in range(40):
        if pressed(pp) == "true" and state(pp) != "idle":
            break
        pp.wait_for_timeout(200)
    print("   state:", state(pp), "| caption:", caption(pp)[:100])
    check("tap: voice on", pressed(pp) == "true", pressed(pp))
    check("listening", state(pp) in ("listening", "thinking", "speaking"), state(pp))
    check("the caption says it is listening", len(caption(pp)) > 5, caption(pp))
    pp.screenshot(path=str(SHOTS / "08-phone-voice-on.png"))
    pp.click("#vai .vai-orb")
    pp.wait_for_timeout(1200)
    check("tap again: voice off", pressed(pp) == "false", pressed(pp))
    check("the microphone is handed back", pp.evaluate("() => window.__streams.length > 0 && window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))"))
    pp.screenshot(path=str(SHOTS / "09-phone-voice-off.png"))
    hold(pp, "#vai .vai-orb")
    pp.wait_for_timeout(700)
    check("hold: the chat sheet", pp.locator("#vai .vai-panel").is_visible())
    check("holding did not toggle voice", pressed(pp) == "false", pressed(pp))
    pp.screenshot(path=str(SHOTS / "10-phone-chat.png"))
    pp.click("#vai .vai-t-min")
    pp.wait_for_timeout(500)
    check("minimise: back to the orb", pp.locator("#vai .vai-orb").is_visible() and pp.locator("#vai .vai-panel").is_hidden())
    check("no JS errors on the phone", not perr, perr[:3])
    phone.close()
    browser.close()

# ---- the wire --------------------------------------------------------------------
print("▶ a spoken turn, straight to /ai/turn")
wav = os.path.join(os.environ.get("TEMP", "."), "vesopa_cloud_voice.wav")
if not os.path.exists(wav):
    ps = ("Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
          f"$s.SetOutputToWaveFile('{wav}'); $s.Speak('Hello. I want to check whether my kitchen dot co dot uk is free, and how much it costs.'); $s.Dispose()")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
s = requests.Session()
s.get(f"{BASE}/")
csrf = s.cookies.get("vh_csrf")
token = s.get(f"{BASE}/ai/session").json().get("token")
snapshot = {"url": "/", "title": "Vesopa Cloud", "headings": ["UK domains, hosting and SSL"], "alerts": [],
            "text": "Search a domain", "elements": [{"ref": "e1", "kind": "text", "name": "q", "label": "Domain name", "placeholder": "yourbusiness.co.uk"}, {"ref": "e2", "kind": "button", "text": "Search"}]}
body = {"audio": {"data": base64.b64encode(open(wav, "rb").read()).decode(), "format": "wav"}, "page": snapshot, "voice": True, "local": {"memory": [], "history": []}}
headers = {"x-csrf-token": csrf, "x-ai-token": token, "origin": BASE}
t = time.time()
r = s.post(f"{BASE}/ai/turn", headers=headers, json=body)
data = r.json()
print(f"   {r.status_code} in {time.time() - t:.1f}s: heard={data.get('heard')!r}")
print(f"   say={data.get('say')!r}")
print(f"   actions={json.dumps(data.get('actions'))[:300]}")
check("heard the clip", "kitchen" in str(data.get("heard", "")).lower(), data.get("heard"))
check("answered", bool(data.get("say")), data)
r2 = s.post(f"{BASE}/ai/turn", headers={"x-csrf-token": csrf, "origin": BASE}, json={"text": "hi", "page": snapshot})
check("refused without the widget token", r2.status_code == 401, r2.status_code)
r3 = s.post(f"{BASE}/ai/turn", headers={"x-csrf-token": csrf, "x-ai-token": token, "origin": "https://evil.example"}, json={"text": "hi", "page": snapshot})
check("refused from another origin", r3.status_code == 403, r3.status_code)

print(f"\n{passed} passed, {failed} failed — screenshots in {SHOTS}")
sys.exit(1 if failed else 0)
