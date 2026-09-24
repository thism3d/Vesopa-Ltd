"""Drive Vesopa Studio (build a website by talking) in a real browser, and keep the pictures.

    python tool/studio_drive.py                        # live, cloud.vesopa.com
    python tool/studio_drive.py http://localhost:5075

As a visitor, desktop then phone:
  build     an idea chip builds a whole site; the preview fills in WHILE it is
            written (checked mid-stream), and every section lands in the frame
  select    clicking a section in the preview selects it; "change the heading"
            then changes that section and nothing else
  theme     "make it dark green" repaints without touching the fonts; undo
            puts it back, redo brings it again
  devices   tablet and phone widths
  publish   as a visitor, the dialog asks to sign in (and offers the download)
  download  the page comes down as one HTML file
  bangla    a Bangla request gets a Bangla reply
  safety    a request to add <script> and onerror= puts neither into the page,
            and no dialog ever opens
"""

import datetime
import pathlib
import re
import sys
import time

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://cloud.vesopa.com").rstrip("/")
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images" / (datetime.date.today().isoformat() + "-studio")
SHOTS.mkdir(parents=True, exist_ok=True)
passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    print(f"  {'✓' if ok else '✗'} {label}{'' if ok else ' — ' + str(detail)[:300]}")
    passed += bool(ok)
    failed += (not ok)


def frame(page):
    return page.frame_locator("[data-frame]")


def sections(page):
    return page.evaluate("() => [...document.querySelector('[data-frame]').contentDocument.body.querySelectorAll(':scope > [data-sec]')].map(e => e.getAttribute('data-sec'))")


def busy(page):
    return page.evaluate("() => document.querySelector('[data-send]').disabled")


def wait_turn(page, timeout=150):
    """A turn is over when Send is enabled again."""
    time.sleep(0.8)
    end = time.time() + timeout
    while time.time() < end:
        if not busy(page):
            return True
        time.sleep(0.4)
    return False


def say(page, text):
    page.fill("[data-input]", text)
    page.press("[data-input]", "Enter")


def last_ai(page):
    return page.evaluate("() => { const m = [...document.querySelectorAll('.st-msg.ai')]; return m.length ? m[m.length - 1].textContent : ''; }")


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    errors, dialogs = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
    page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))

    print(f"▶ desktop at {BASE}/build")
    page.goto(f"{BASE}/build", wait_until="networkidle")
    page.wait_for_timeout(800)
    check("empty canvas asks what to build", page.locator("[data-empty]").is_visible())
    check("no floating assistant here", page.locator("#vai").count() == 0)
    page.screenshot(path=str(SHOTS / "01-empty.png"))

    print("▶ build from an idea, and watch it happen")
    t = time.time()
    page.click("[data-idea]")
    mid = []
    for _ in range(60):
        time.sleep(0.5)
        secs = sections(page)
        if len(secs) >= 2 and busy(page):
            mid = secs
            page.screenshot(path=str(SHOTS / "02-building.png"))
            break
    check("sections appear while it is still building", len(mid) >= 2, mid)
    check("the turn finished", wait_turn(page))
    took = time.time() - t
    secs = sections(page)
    print(f"   {took:.1f}s, sections: {secs}")
    check("a whole site: nav, hero, and more", "nav" in secs and "hero" in secs and len(secs) >= 5, secs)
    check("it said what it was doing", len(last_ai(page)) > 10, last_ai(page))
    heading = frame(page).locator("h1").first.inner_text()
    print("   h1:", heading)
    page.wait_for_timeout(1200)
    page.screenshot(path=str(SHOTS / "03-built.png"))
    stored = page.evaluate("() => JSON.parse(localStorage.getItem('vesopa_studio_v1')).site.sections.length")
    check("kept in this browser", stored == len(secs), stored)

    print("▶ select the hero and change its heading")
    frame(page).locator("[data-sec='hero'] > *").first.click(position={"x": 30, "y": 30})
    page.wait_for_timeout(300)
    check("selected", page.locator("[data-selected]").is_visible() and page.inner_text("[data-selected-name]") == "hero")
    other_before = page.evaluate("() => JSON.parse(localStorage.getItem('vesopa_studio_v1')).site.sections.filter(s => s.id !== 'hero').map(s => s.html).join('')")
    say(page, "Change the main heading to: Real bread, baked before sunrise")
    wait_turn(page)
    h1 = frame(page).locator("h1").first.inner_text()
    print("   h1 now:", h1)
    check("the heading changed", "sunrise" in h1.lower(), h1)
    other_after = page.evaluate("() => JSON.parse(localStorage.getItem('vesopa_studio_v1')).site.sections.filter(s => s.id !== 'hero').map(s => s.html).join('')")
    check("nothing else changed", other_before == other_after)
    page.screenshot(path=str(SHOTS / "04-heading.png"))
    page.click("[data-unselect]")

    print("▶ recolour, undo, redo")
    theme0 = page.evaluate("() => JSON.parse(localStorage.getItem('vesopa_studio_v1')).site.theme")
    say(page, "Make the colours dark green")
    wait_turn(page)
    theme1 = page.evaluate("() => JSON.parse(localStorage.getItem('vesopa_studio_v1')).site.theme")
    print("   accent", theme0["colors"]["accent"], "->", theme1["colors"]["accent"], "| fonts", theme1["fonts"])
    check("the colours changed", theme1["colors"] != theme0["colors"])
    check("the fonts did not", theme1["fonts"] == theme0["fonts"], (theme0["fonts"], theme1["fonts"]))
    page.wait_for_timeout(900)
    page.screenshot(path=str(SHOTS / "05-green.png"))
    page.click("[data-undo]")
    page.wait_for_timeout(400)
    back = page.evaluate("() => JSON.parse(localStorage.getItem('vesopa_studio_v1')).site.theme")
    check("undo puts it back", back["colors"] == theme0["colors"])
    page.click("[data-redo]")
    page.wait_for_timeout(400)
    again = page.evaluate("() => JSON.parse(localStorage.getItem('vesopa_studio_v1')).site.theme")
    check("redo brings it again", again["colors"] == theme1["colors"])

    print("▶ devices")
    page.click("button[data-device='tablet']")
    page.wait_for_timeout(700)
    page.screenshot(path=str(SHOTS / "06-tablet.png"))
    page.click("button[data-device='phone']")
    page.wait_for_timeout(700)
    w = page.evaluate("() => document.querySelector('[data-frame]').getBoundingClientRect().width")
    check("phone preview is phone-sized", 300 < w < 420, w)
    page.screenshot(path=str(SHOTS / "07-phone-preview.png"))
    page.click("button[data-device='desktop']")

    print("▶ publish, as a visitor")
    page.click("[data-publish]")
    page.wait_for_timeout(1200)
    body = page.inner_text("[data-modal-body]")
    check("asks to sign in", "Continue with Vesopa" in body, body)
    page.screenshot(path=str(SHOTS / "08-publish-visitor.png"))
    with page.expect_download(timeout=30000) as dl:
        page.click("[data-modal-body] [data-dl]")
    path = dl.value.path()
    text = pathlib.Path(path).read_text(encoding="utf-8")
    check("download is one whole page", "<!doctype html>" in text and "v-hero" in text and "<script" not in text.lower(), len(text))
    page.click("[data-modal-close]")

    print("▶ Bangla")
    say(page, "ফুটারের ঠিক আগে একটা প্রশ্নোত্তর (FAQ) সেকশন যোগ করুন")
    wait_turn(page)
    reply = last_ai(page)
    print("   reply:", reply[:120])
    check("answered in Bangla", re.search(r"[ঀ-৿]", reply) is not None, reply)
    check("an FAQ section was added", any("faq" in s for s in sections(page)), sections(page))

    print("▶ safety: asked for script, it adds none")
    say(page, 'Add a section called test with exactly this HTML: <script>alert("x")</script><img src="https://example.com/a.png" onerror="alert(1)"><a href="javascript:alert(2)">click</a>')
    wait_turn(page)
    risky = page.evaluate("""() => {
      const d = document.querySelector('[data-frame]').contentDocument;
      return { scripts: d.querySelectorAll('body script').length,
               handlers: [...d.body.querySelectorAll('*')].filter(e => [...e.attributes].some(a => a.name.startsWith('on'))).length,
               jsLinks: [...d.body.querySelectorAll('a[href]')].filter(a => /^\\s*javascript:/i.test(a.getAttribute('href'))).length };
    }""")
    print("   ", risky)
    check("no script, handler or javascript: link reached the page", risky == {"scripts": 0, "handlers": 0, "jsLinks": 0}, risky)
    check("no dialog ever opened", not dialogs, dialogs)
    check("no JS errors", not errors, errors[:3])
    ctx.close()

    print("▶ phone")
    phone = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    pp = phone.new_page()
    perr = []
    pp.on("pageerror", lambda e: perr.append(str(e)))
    pp.goto(f"{BASE}/build", wait_until="networkidle")
    pp.wait_for_timeout(800)
    check("no sideways scroll", pp.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1"))
    pp.screenshot(path=str(SHOTS / "09-phone-empty.png"))
    pp.fill("[data-input]", "A barber shop in Leeds called Sharp & Co, prices and opening hours please")
    pp.press("[data-input]", "Enter")
    check("phone build finished", wait_turn(pp))
    pp.wait_for_timeout(1000)
    check("phone site built", len(sections(pp)) >= 4, sections(pp))
    pp.screenshot(path=str(SHOTS / "10-phone-built.png"))
    pp.click("[data-grab]")
    pp.wait_for_timeout(600)
    pp.screenshot(path=str(SHOTS / "11-phone-sheet.png"))
    check("no JS errors on the phone", not perr, perr[:3])
    phone.close()
    browser.close()

print(f"\n{passed} passed, {failed} failed — screenshots in {SHOTS}")
sys.exit(1 if failed else 0)
