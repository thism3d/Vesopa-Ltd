"""Photograph auth.vesopa.com at chosen widths, in both colour schemes.

    python tool/auth_shot.py <tag> <path> [width,width,...]

    python tool/auth_shot.py login /login 1280,390

Shots are written under Documents\\Vesopa-Claude-Images and are never deleted:
the owner checks that evidence afterwards, so a screenshot taken to answer a
question has to still be there when the question is asked again.

Both colour schemes are captured every time. A login page is used at night, and
the dark one is not a nice-to-have that can be checked later — a page that only
defines its colours inside a light-mode block goes transparent-on-black in the
other, and nobody sees it until a customer does.
"""

import pathlib
import sys
from datetime import date

from playwright.sync_api import sync_playwright

BASE = "https://auth.vesopa.com"
OUT = pathlib.Path(
    rf"C:\Users\Administrator\Documents\Vesopa-Claude-Images\{date.today()}-auth-vesopa"
)


def normalise_path(raw):
    """Undo Git Bash's helpfulness, and accept a path written either way.

    MSYS rewrites anything that looks like a POSIX path on its way to a native
    Windows program, so `python auth_shot.py login /login` arrives here as
    `C:/Program Files/Git/login` and the browser is sent to
    `https://auth.vesopa.comc/Program Files/Git/login`. The error names DNS,
    which sends you looking at the wrong thing entirely.

    So: strip the prefix if it happened, and accept `login` as readily as
    `/login`, which avoids the conversion in the first place.
    """
    path = str(raw).replace("\\", "/")
    marker = "/Git/"
    if marker in path:
        path = path.split(marker, 1)[1]
    path = path.split(":", 1)[-1] if path[1:3] == ":/" else path
    return "/" + path.lstrip("/")


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "login"
    path = normalise_path(sys.argv[2] if len(sys.argv) > 2 else "login")
    widths = [int(w) for w in (sys.argv[3] if len(sys.argv) > 3 else "1280,390").split(",")]

    OUT.mkdir(parents=True, exist_ok=True)
    written = []

    with sync_playwright() as play:
        browser = play.chromium.launch()
        try:
            for scheme in ("light", "dark"):
                for width in widths:
                    context = browser.new_context(
                        viewport={"width": width, "height": 900 if width > 500 else 844},
                        device_scale_factor=2,
                        color_scheme=scheme,
                    )
                    page = context.new_page()

                    # Collect what the browser objects to. A blocked script, a
                    # 404 icon or a CSP refusal is completely invisible in a
                    # screenshot — the page just looks slightly wrong, or looks
                    # fine and is broken for somebody else.
                    problems = []
                    page.on(
                        "console",
                        lambda m: problems.append(f"console {m.type}: {m.text}")
                        if m.type in ("error", "warning")
                        else None,
                    )
                    page.on(
                        "response",
                        lambda r: problems.append(f"HTTP {r.status} {r.url}")
                        if r.status >= 400
                        else None,
                    )

                    # `load`, not `networkidle`. networkidle waits for the
                    # network to go quiet for half a second, and never fires on
                    # a page holding a connection open — which this one does the
                    # moment conditional-UI WebAuthn is waiting on the email
                    # field. The screenshot then times out on a page that is
                    # perfectly finished.
                    page.goto(f"{BASE}{path}", wait_until="load", timeout=30000)
                    page.wait_for_timeout(600)

                    target = OUT / f"{tag}-{width}-{scheme}.png"
                    page.screenshot(path=str(target), full_page=True)
                    written.append(target)
                    print(f"{target.name}  {target.stat().st_size // 1024} KB")
                    for problem in dict.fromkeys(problems):
                        print(f"    ! {problem}")

                    context.close()
        finally:
            browser.close()

    print(f"\n{len(written)} shots in {OUT}")


if __name__ == "__main__":
    main()
