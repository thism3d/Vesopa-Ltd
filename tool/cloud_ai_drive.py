"""Drive Vesopa AI on cloud.vesopa.com in a real browser, and keep the pictures.

    python tool/cloud_ai_drive.py

As a visitor (nobody signed in):
  desktop  the first tap asks for the microphone; here it is refused, so the
           assistant falls back to typing, greets, checks a domain and puts it
           in the basket, and is still there after the router changes the page
  phone    the microphone is granted (Chromium's fake device), so the first
           tap gives the voice bar; the keyboard button opens the chat sheet
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

BASE = "https://cloud.vesopa.com"
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


def transcript(page):
    return page.evaluate("() => [...document.querySelectorAll('#vai .vai-msg')].map(m => m.className.replace('vai-msg ','') + ': ' + m.textContent.trim())")


with sync_playwright() as p:
    # A fake microphone, so the phone half can be granted one; the desktop
    # half refuses it by hand, to walk the other path.
    browser = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])

    # ---- desktop, microphone refused ----------------------------------------
    ctx = browser.new_context(viewport={"width": 1280, "height": 860})
    ctx.add_init_script("navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    print("▶ desktop: the orb, the hello bubble")
    page.goto(f"{BASE}/", wait_until="networkidle")
    page.wait_for_timeout(2500)
    check("orb is there", page.locator("#vai .vai-orb").count() == 1)
    check("hello bubble appears once", page.locator("#vai .vai-hello").count() == 1)
    page.screenshot(path=str(SHOTS / "01-orb-hello.png"))

    print("▶ first tap asks for the mic; refused here, so it types")
    page.click("#vai .vai-orb")
    page.wait_for_selector("#vai .vai-panel", state="visible")
    page.wait_for_timeout(1200)
    page.screenshot(path=str(SHOTS / "02-first-tap.png"))
    wait_idle(page)
    page.wait_for_timeout(600)
    msgs = transcript(page)
    check("fell back to text and greeted", any(m.startswith("ai:") for m in msgs), msgs)
    page.screenshot(path=str(SHOTS / "03-greeting.png"))

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
    print("▶ phone: the voice bar")
    phone = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2, permissions=["microphone"])
    pp = phone.new_page()
    perr = []
    pp.on("pageerror", lambda e: perr.append(str(e)))
    pp.goto(f"{BASE}/domains", wait_until="networkidle")
    pp.wait_for_timeout(800)
    pp.click("#vai .vai-orb")
    pp.wait_for_timeout(1500)
    check("bar shown on first tap", pp.locator("#vai .vai-bar").is_visible())
    pp.screenshot(path=str(SHOTS / "07-phone-bar-first.png"))
    wait_idle(pp, 90)
    pp.wait_for_timeout(800)
    st = pp.evaluate("() => document.querySelector('#vai .vai-bar').getAttribute('data-state')")
    line = pp.evaluate("() => document.querySelector('#vai .vai-bar-line').textContent")
    print("   bar:", st, "|", line[:120])
    check("voice on and listening", st in ("listening", "idle", "speaking"), st)
    check("greeting shown on the bar", len(line) > 10, line)
    pp.screenshot(path=str(SHOTS / "08-phone-bar-greeted.png"))
    pp.click("#vai .vai-bar-kb")
    pp.wait_for_timeout(600)
    check("keyboard opens the chat sheet", pp.locator("#vai .vai-panel").is_visible())
    pp.screenshot(path=str(SHOTS / "09-phone-chat.png"))
    pp.click("#vai .vai-t-bar")
    pp.wait_for_timeout(500)
    check("back to the bar", pp.locator("#vai .vai-bar").is_visible() and pp.locator("#vai .vai-panel").is_hidden())
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
