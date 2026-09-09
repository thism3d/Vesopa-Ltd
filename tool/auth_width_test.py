"""No page on auth.vesopa.com may be wider than the phone it is on.

    python tool/auth_width_test.py            # every page, 360px
    python tool/auth_width_test.py 320        # and the narrowest phone still in use

The reference document's last decision, made a test rather than a memory:

    "Nothing wider than the viewport, ever. The measurement above should become
     a test, not a one-off."

WHY THIS KEEPS HAPPENING, and why a test is the only thing that stops it. A grid
or flex item defaults to `min-width: auto`, which means it will not shrink below
its own content. One long email address, one unbreakable client id, one row of
buttons that does not wrap, and the page scrolls sideways — on a phone, which is
where most of these pages are actually read. It is invisible on a laptop, so it
ships, and the person who finds it is a customer.

The failure is also cheap to describe and expensive to find: this reports the
overflow AND names the widest element responsible, so a failure is a fix rather
than an investigation.

Signed in, because the pages that overflow are the signed-in ones — it mints a
short session the same way tool/auth_console_shot.py does.
"""

import pathlib
import subprocess
import sys

from playwright.sync_api import sync_playwright

# The Windows console defaults to cp1252, which cannot encode a tick — and the
# failure is a traceback in the middle of a passing test run rather than a
# result. Every other tool here does the same.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

ROOT = pathlib.Path(__file__).resolve().parents[1]
SSH = ROOT / "tool" / "auth_ssh.py"
BASE = "https://auth.vesopa.com"
ADMIN = "info@vesopasoftware.com"

# Public pages, then the signed-in ones. The list is deliberately long: a page
# left out of it is a page that will overflow one day and nobody will know.
PAGES = [
    "/", "/login", "/docs", "/policies", "/privacy", "/terms", "/security",
    "/account/profile", "/account/security", "/account/linked",
    "/account/devices", "/account/history", "/account/apps",
    "/admin", "/admin/people", "/admin/applications", "/admin/activity",
    "/admin/health", "/admin/settings",
    "/developers", "/developers/new",
]

FIND_CULPRIT = """
(w) => {
  const over = [];
  document.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.right > w + 1 || r.width > w + 1) {
      over.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.baseVal !== undefined
              ? el.className.baseVal : String(el.className || '')).slice(0, 60),
        width: Math.round(r.width),
        right: Math.round(r.right),
      });
    }
  });
  // The widest one whose parent is NOT also over is the cause; everything
  // above it is just being dragged along.
  over.sort((a, b) => b.width - a.width);
  return over.slice(0, 4);
}
"""


def mint():
    out = subprocess.run(
        [sys.executable, str(SSH), "run",
         f"cd @app && node scripts/console-session.js {ADMIN}"],
        cwd=str(ROOT), text=True, capture_output=True,
    )
    lines = (out.stdout or "").strip().splitlines()
    if out.returncode != 0 or not lines:
        print(out.stdout, out.stderr, file=sys.stderr)
        raise SystemExit("could not mint a session")
    return lines[-1].strip()


def main():
    width = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 360
    token = mint()

    passed = failed = 0
    with sync_playwright() as play:
        browser = play.chromium.launch()
        context = browser.new_context(viewport={"width": width, "height": 900})
        context.add_cookies([{
            "name": "__Host-vesopa_sid", "value": token, "url": f"{BASE}/",
            "secure": True, "httpOnly": True, "sameSite": "Lax",
        }])
        page = context.new_page()

        print(f"No sideways scroll at {width}px\n")
        for path in PAGES:
            try:
                page.goto(f"{BASE}{path}", wait_until="load", timeout=30000)
                page.wait_for_timeout(250)
            except Exception as error:  # noqa: BLE001 — report, do not stop
                failed += 1
                print(f"  ✗ {path:<26} could not load: {error}")
                continue

            scroll = page.evaluate("() => document.documentElement.scrollWidth")
            client = page.evaluate("() => document.documentElement.clientWidth")
            if scroll <= client + 1:
                passed += 1
                print(f"  ✓ {path}")
            else:
                failed += 1
                print(f"  ✗ {path:<26} {scroll - client}px too wide")
                for el in page.evaluate(FIND_CULPRIT, client):
                    print(f"        {el['tag']}.{el['cls']}  {el['width']}px, right {el['right']}")

        browser.close()

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
