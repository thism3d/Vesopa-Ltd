"""Add a domain through the panel and watch the setup card do its work.

    python tool/cloud_domain_add_drive.py

As the developer's own account (customer 5): adds `claude-test.muzahidislam.com`
through /panel/domains/add, records how long the form post took to answer,
photographs the card as steps light up, checks the Domains list says
"Setting up…" meanwhile, waits for the outcome, and then removes the
subdomain again. Frames go under Documents\\Vesopa-Claude-Images.
"""

import datetime
import pathlib
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = "https://cloud.vesopa.com"
CUSTOMER_ID = 5
NAME = sys.argv[1] if len(sys.argv) > 1 else "claude-test.muzahidislam.com"
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images" / (
    datetime.date.today().isoformat() + "-cloud-domain-add"
)
SHOTS.mkdir(parents=True, exist_ok=True)

MINT = (
    "cd @app && su - vesopasoftware -c 'cd /home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp && "
    "node -e \"require(\\\"dotenv\\\").config(); const db=require(\\\"./src/db\\\"),auth=require(\\\"./src/auth\\\"); "
    f"db.one(\\\"SELECT * FROM customers WHERE id={CUSTOMER_ID}\\\").then(c=>{{auth.issueCustomerSession({{cookie:(n,v)=>console.log(\\\"COOKIE \\\"+v)}},c);process.exit(0)}})\"'"
)

passed = 0
failed = 0


def check(label, ok, detail=""):
    global passed, failed
    print(f"  {'✓' if ok else '✗'} {label}{'' if ok else ' — ' + str(detail)}")
    if ok:
        passed += 1
    else:
        failed += 1


result = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "run", MINT], cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", capture_output=True)
token = next((line.split(" ", 1)[1].strip() for line in result.stdout.splitlines() if line.startswith("COOKIE ")), "")
if not token:
    raise SystemExit("could not mint a session:\n" + result.stdout + result.stderr)

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": 1280, "height": 900}, bypass_csp=True)
    context.add_cookies([{"name": "vh_session", "value": token, "url": BASE}])
    page = context.new_page()
    watcher = context.new_page()  # a second tab, to look at the Domains list meanwhile

    print("▶ the form")
    page.goto(f"{BASE}/panel/domains/add", wait_until="networkidle")
    page.fill("#domain", NAME)
    page.screenshot(path=str(SHOTS / "01-form.png"))
    t0 = time.time()
    page.locator('form[action="/panel/domains/add"] button[type="submit"]').first.click()
    page.wait_for_function("document.querySelector('[data-domain-setup]') !== null", timeout=30000)
    answered = time.time() - t0
    check("the form answered quickly", answered < 6, f"{answered:.1f}s")
    print(f"    form answered in {answered:.1f}s")
    check("landed on the domain page", NAME in page.url, page.url)
    check("the setup card is there and running", page.evaluate("document.querySelector('[data-domain-setup]').dataset.finished") == "0")
    steps = page.evaluate("Array.from(document.querySelectorAll('.dsetup-step b')).map(e => e.textContent)")
    print("    planned:", steps)
    check("every step is listed from the start", len(steps) >= 4, steps)
    page.screenshot(path=str(SHOTS / "02-card-start.png"))

    print("▶ meanwhile, the Domains list")
    watcher.goto(f"{BASE}/panel/domains", wait_until="networkidle")
    chip = watcher.evaluate(
        f"""(() => {{ const a = Array.from(document.querySelectorAll('a.item')).find(a => a.textContent.includes('{NAME}'));
                     return a ? {{ chip: a.querySelector('[data-live-chip]')?.textContent.trim(), line: a.querySelector('[data-live-line]')?.textContent.trim() }} : null; }})()"""
    )
    print("    list says:", chip)
    check("the list says it is being set up", bool(chip) and "Setting up" in (chip.get("chip") or ""), chip)
    watcher.screenshot(path=str(SHOTS / "03-list-meanwhile.png"))

    print("▶ watching the steps")
    seen_running = set()
    frame = 4
    deadline = time.time() + 90
    while time.time() < deadline:
        state = page.evaluate(
            """() => ({ finished: document.querySelector('[data-domain-setup]').dataset.finished,
                        running: Array.from(document.querySelectorAll('.dsetup-step.is-running b')).map(e => e.textContent),
                        pct: document.querySelector('[data-ds-bar]').getAttribute('aria-valuenow'),
                        title: document.querySelector('[data-ds-title]').textContent.trim() })"""
        )
        for r in state["running"]:
            if r not in seen_running:
                seen_running.add(r)
                page.screenshot(path=str(SHOTS / f"{frame:02d}-step-{len(seen_running)}.png"))
                frame += 1
                print(f"    {state['pct']}%  running: {r}")
        if state["title"] and not state["title"].startswith("Setting up"):
            break
        page.wait_for_timeout(500)
    check("more than one step was seen running", len(seen_running) >= 2, seen_running)
    elapsed = time.time() - t0
    print(f"    outcome after {elapsed:.0f}s: {state['title']}")
    # The card refreshes the page through the router once the run ends; the
    # server-rendered card carries data-finished="1", the client-painted one
    # still says "0". Wait for the real thing.
    page.wait_for_function("document.querySelector('[data-domain-setup]')?.dataset.finished === '1'", timeout=30000)
    page.wait_for_load_state("networkidle")
    page.screenshot(path=str(SHOTS / f"{frame:02d}-outcome.png"), full_page=True)
    below = page.inner_text("main")
    if "is set up and serving" in below:
        check("the page below the card agrees with the outcome", "Not pointing here yet" not in below and "None yet" not in below, "stale verdicts under a green card")
    final = page.evaluate("Array.from(document.querySelectorAll('.dsetup-step')).map(li => li.className.replace('dsetup-step is-','') + ':' + li.querySelector('b').textContent + ' — ' + (li.querySelector('span span')?.textContent || ''))")
    for line in final:
        print("    ", line)
    check("the page refreshed itself without a reload", page.evaluate("performance.getEntriesByType('navigation').length") == 1)
    check("the outcome is shown", page.evaluate("!!document.querySelector('[data-domain-setup]')"))
    check("no step is still pending or running", not any(l.startswith(("pending", "running")) for l in final), final)

    print("▶ the notification")
    page.goto(f"{BASE}/panel/notifications", wait_until="networkidle")
    body = page.inner_text("body")
    check("a notification carries the outcome", NAME in body)
    page.screenshot(path=str(SHOTS / "90-notifications.png"))

    print("▶ clean up")
    page.goto(f"{BASE}/panel/domains/{NAME}", wait_until="networkidle")
    page.on("dialog", lambda d: d.accept())
    remove = page.locator('form[action$="/remove"] button[type="submit"]')
    if remove.count():
        remove.first.click()
        # The removal answers with a redirect once the node has let go of the
        # site, the zone and the record — up to fifteen seconds.
        page.wait_for_function("location.pathname === '/panel/domains'", timeout=60000)
        page.wait_for_load_state("networkidle")
        check("removed again", NAME not in page.inner_text("main"))
    else:
        check("removed again", False, "no remove form found — remove it by hand")

    browser.close()

print(f"\n{passed} passed, {failed} failed\nframes: {SHOTS}")
raise SystemExit(0 if failed == 0 else 1)
