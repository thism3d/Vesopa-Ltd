"""Find what makes an auth.vesopa.com page scroll sideways on a phone.

    python tool/auth_overflow.py account/profile [width]

WITHOUT a leading slash. Git Bash rewrites anything POSIX-looking on its way to
a native Windows program, so "/account/profile" arrives here as
"C:/Program Files/Git/account/profile" and the tool cheerfully measures a 404.
A leading slash is stripped below rather than refused, so either form works.

Signed in, because the pages that overflow are the signed-in ones. It reports
the document's own overflow first, then names every element whose right edge is
past the viewport — the culprit is the widest one whose PARENT is not also over,
which is printed last as the verdict.

Written because "the card is too wide" is a guess. Twice on this project the
obvious element was innocent and a `min-width: auto` on a grid child three
levels up was the cause.
"""

import os
import pathlib
import subprocess
import sys
from datetime import date

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = os.environ.get("VESOPA_AUTH_BASE", "https://auth.vesopa.com")
OUT = pathlib.Path(
    rf"C:\Users\Administrator\Documents\Vesopa-Claude-Images\{date.today()}-auth-overflow"
)


def session(who="info@vesopasoftware.com"):
    """A fifteen-minute console session, minted by the server.

    The same helper auth_console_shot.py uses. Signing in for real is not an
    option from here: it needs a code in a real mailbox.
    """
    result = subprocess.run(
        [sys.executable, str(ROOT / "tool" / "auth_ssh.py"), "run",
         f"cd @app && node scripts/console-session.js {who}"],
        cwd=str(ROOT), text=True, capture_output=True,
    )
    lines = (result.stdout or "").strip().splitlines()
    if result.returncode != 0 or not lines:
        print(result.stdout, result.stderr, file=sys.stderr)
        raise SystemExit("could not mint a session")
    return lines[-1].strip()


MEASURE = """
(width) => {
  const doc = document.documentElement;
  const over = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > width + 1 || r.left < -1) {
      over.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.baseVal !== undefined
              ? el.className.baseVal : String(el.className || '')).slice(0, 46),
        id: el.id || '',
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        text: (el.textContent || '').trim().slice(0, 30),
        parentOver: (() => {
          const p = el.parentElement;
          if (!p) return false;
          const pr = p.getBoundingClientRect();
          return pr.right > width + 1 || pr.left < -1;
        })(),
      });
    }
  }
  /*
   * The chain from <html> down, measured. The overflowing element is rarely
   * the one that CAUSES the overflow — a grid or flex child with no
   * `min-width: 0` blows out the track above it, and the visible symptom is
   * three levels away from the rule that has to change.
   */
  const chain = [];
  for (const sel of ['html', 'body', '.console', '.rail', '.console-main',
                     '.topbar', '.panel', '.account', 'form']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    chain.push({
      sel,
      width: Math.round(r.width),
      scrollWidth: el.scrollWidth,
      minWidth: cs.minWidth,
      overflowX: cs.overflowX,
      display: cs.display,
    });
  }

  return {
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    chain,
    over,
  };
}
"""


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "account/profile"
    # Undo Git Bash's path mangling, then normalise to a leading slash.
    marker = "/Git/"
    if marker in path:
        path = path.split(marker, 1)[1]
    path = "/" + path.lstrip("/")
    width = int(sys.argv[2]) if len(sys.argv) > 2 else 360

    OUT.mkdir(parents=True, exist_ok=True)
    token = session()

    with sync_playwright() as play:
        browser = play.chromium.launch()
        context = browser.new_context(viewport={"width": width, "height": 800})
        # `url` only — Playwright rejects a cookie carrying both url and path.
        context.add_cookies([{ "name": "__Host-vesopa_sid", "value": token,
                               "url": BASE, "httpOnly": True, "secure": True }])
        page = context.new_page()

        page.goto(f"{BASE}{path}", wait_until="load", timeout=30000)
        page.wait_for_timeout(700)

        result = page.evaluate(MEASURE, width)

        print(f"{path} at {width}px\n")
        print(f"  document scrollWidth : {result['scrollWidth']}")
        print(f"  document clientWidth : {result['clientWidth']}")
        print(f"  body scrollWidth     : {result['bodyScrollWidth']}")
        overflow = result["scrollWidth"] - result["clientWidth"]
        print(f"  OVERFLOW             : {overflow}px\n")

        print(f"{'selector':<16}{'width':>8}{'scrollW':>9}{'min-width':>11}{'overflow-x':>12}{'display':>10}")
        for row in result["chain"]:
            print(f"{row['sel']:<16}{row['width']:>8}{row['scrollWidth']:>9}"
                  f"{row['minWidth']:>11}{row['overflowX']:>12}{row['display']:>10}")
        print()

        if not result["over"]:
            print("  nothing sticks out.")
        else:
            print(f"{'element':<52}{'left':>7}{'right':>8}{'width':>8}")
            for row in result["over"]:
                name = f"{row['tag']}"
                if row["id"]:
                    name += f"#{row['id']}"
                if row["cls"]:
                    name += f".{row['cls'].replace(' ', '.')}"
                print(f"{name[:52]:<52}{row['left']:>7}{row['right']:>8}{row['width']:>8}")

            roots = [r for r in result["over"] if not r["parentOver"]]
            print("\n  THE CULPRITS — over, inside a parent that is not:")
            for row in roots:
                name = f"{row['tag']}"
                if row["id"]:
                    name += f"#{row['id']}"
                if row["cls"]:
                    name += f".{row['cls'].replace(' ', '.')}"
                print(f"    {name}  ({row['width']}px wide, right edge {row['right']})")
                if row["text"]:
                    print(f"      text: {row['text']}")

        shot = OUT / f"{path.strip('/').replace('/', '-') or 'home'}-{width}.png"
        page.screenshot(path=str(shot), full_page=True)
        print(f"\n  shot: {shot}")

        browser.close()


if __name__ == "__main__":
    main()
