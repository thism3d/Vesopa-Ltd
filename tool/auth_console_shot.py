"""Photograph the SIGNED-IN pages of auth.vesopa.com.

    python tool/auth_console_shot.py                       # every console page
    python tool/auth_console_shot.py admin developers      # only those groups
    python tool/auth_console_shot.py --path admin/health   # one page
    python tool/auth_console_shot.py --as them@example.com developers

`auth_shot.py` cannot reach any of these: the account area, the administrator's
console and the developer portal all need a session, and a session needs a real
code in a real mailbox. So this asks the server to mint one — see
`vesopa_auth/scripts/console-session.js`, which explains why that is not a back
door — sets it as the cookie, and drives a real browser.

Shots are written under Documents\\Vesopa-Claude-Images and are never deleted:
the owner checks that evidence afterwards, so a screenshot taken to answer a
question has to still be there when the question is asked again.

BOTH COLOUR SCHEMES, EVERY TIME. A console is used at night as readily as a
sign-in page, and a page that defines its colours only inside a light-mode
block goes transparent-on-black in the other — which nobody sees until a
customer does.
"""

import pathlib
import subprocess
import sys
from datetime import date

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
SSH = ROOT / "tool" / "auth_ssh.py"
BASE = "https://auth.vesopa.com"
ADMIN = "info@vesopasoftware.com"

OUT = pathlib.Path(
    rf"C:\Users\Administrator\Documents\Vesopa-Claude-Images\{date.today()}-auth-console"
)

# Grouped so a run can be narrowed while working on one section.
PAGES = {
    "account": [
        ("account-profile", "/account/profile"),
        ("account-security", "/account/security"),
        ("account-linked", "/account/linked"),
        ("account-devices", "/account/devices"),
        ("account-history", "/account/history"),
        ("account-apps", "/account/apps"),
    ],
    "admin": [
        ("admin-overview", "/admin"),
        ("admin-people", "/admin/people"),
        ("admin-applications", "/admin/applications"),
        ("admin-activity", "/admin/activity"),
        ("admin-health", "/admin/health"),
        ("admin-settings", "/admin/settings"),
    ],
    "developers": [
        ("dev-index", "/developers"),
        ("dev-new", "/developers/new"),
    ],
}


def mint_session(who=ADMIN):
    """Ask the server for a fifteen-minute session token for one account.

    `--as` matters more than it looks: the interesting question about the
    developer portal is not what an administrator sees — they see everything —
    but what somebody granted ONE application sees. That can only be answered by
    being them.
    """
    result = subprocess.run(
        [
            sys.executable,
            str(SSH),
            "run",
            f"cd @app && node scripts/console-session.js {who}",
        ],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
    )
    token = (result.stdout or "").strip().splitlines()
    if result.returncode != 0 or not token:
        print(result.stdout, result.stderr, file=sys.stderr)
        raise SystemExit("could not mint a session")
    return token[-1].strip()


def main():
    # Values that belong to a flag are not group names.
    raw = sys.argv[1:]
    consumed = set()
    for i, a in enumerate(raw):
        if a in ("--path", "--as"):
            consumed.add(i)
            consumed.add(i + 1)
    args = [a for i, a in enumerate(raw) if i not in consumed and not a.startswith("--")]
    extra = []
    if "--path" in sys.argv:
        # A single page, named on the command line: `--path admin/health`.
        raw = sys.argv[sys.argv.index("--path") + 1]
        raw = raw.split("/Git/")[-1]
        extra = [(raw.strip("/").replace("/", "-") or "root", "/" + raw.strip("/"))]

    wanted = extra or [
        page for group in (args or PAGES.keys()) for page in PAGES.get(group, [])
    ]
    if not wanted:
        raise SystemExit(f"nothing to shoot — groups are {', '.join(PAGES)}")

    who = ADMIN
    if "--as" in sys.argv:
        who = sys.argv[sys.argv.index("--as") + 1]
    token = mint_session(who)
    OUT.mkdir(parents=True, exist_ok=True)
    written = 0

    with sync_playwright() as play:
        browser = play.chromium.launch()
        try:
            for scheme in ("light", "dark"):
                context = browser.new_context(
                    viewport={"width": 1360, "height": 960},
                    device_scale_factor=2,
                    color_scheme=scheme,
                )
                # `__Host-` refuses any cookie carrying a Domain attribute, so
                # it has to be set by URL — and Playwright rejects `url` and
                # `path` together, taking the path from the URL instead. Getting
                # this wrong drops the cookie silently and every page below
                # redirects to /login, which reads like a broken session.
                context.add_cookies(
                    [
                        {
                            "name": "__Host-vesopa_sid",
                            "value": token,
                            "url": BASE + "/",
                            "secure": True,
                            "httpOnly": True,
                            "sameSite": "Lax",
                        }
                    ]
                )
                page = context.new_page()

                for tag, path in wanted:
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

                    page.goto(f"{BASE}{path}", wait_until="load", timeout=30000)
                    page.wait_for_timeout(400)

                    # A redirect to /login means the cookie did not take, and a
                    # gallery of sign-in pages is a confusing way to find that
                    # out an hour later.
                    if "/login" in page.url and path != "/login":
                        print(f"    ! {path} bounced to {page.url}")

                    prefix = "" if who == ADMIN else who.split("@")[0] + "-"
                    target = OUT / f"{prefix}{tag}-{scheme}.png"
                    page.screenshot(path=str(target), full_page=True)
                    written += 1
                    print(f"{target.name}  {target.stat().st_size // 1024} KB")
                    for problem in dict.fromkeys(problems):
                        print(f"    ! {problem}")

                context.close()
        finally:
            browser.close()

    print(f"\n{written} shots in {OUT}")


if __name__ == "__main__":
    main()
