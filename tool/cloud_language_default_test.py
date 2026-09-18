"""Does a Bangladeshi visitor get the Bangla site, and a way back to English?

    python tool/cloud_language_default_test.py

What it checks, as four different visitors:

  from Bangladesh, no cookies     -> redirected to /bn, and offered English
  from Bangladesh, chose English  -> left in English, never redirected
  from anywhere else              -> English, as before
  a crawler from Bangladesh       -> never redirected, so both languages stay
                                     indexable at their own addresses

The country cookie is minted signed, because the server signs it -- but the
redirect must NOT depend on one: the third run sends no country cookie at all
and relies on the address lookup, which is the path a real first-time visitor
takes.
"""

import datetime
import json
import pathlib
import subprocess
import sys

import requests

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://cloud.vesopa.com").rstrip("/")
HOST = BASE.split("//")[1]
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images"
STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"
CRAWLER = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"


def signed_country_cookie(cc):
    node = (
        'require("dotenv").config();'
        'const c=require("crypto");'
        'const s=process.env.GEO_SALT||process.env.SESSION_SECRET||"vesopa-geo";'
        f'console.log("{cc}."+c.createHmac("sha256",s).update("cc:{cc}")'
        '.digest("base64url").slice(0,16));'
    )
    out = subprocess.run(
        [sys.executable, "tool/cloud_ssh.py", "run",
         "A=/home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp; cd $A && "
         f"su vesopasoftware -c 'cd $PWD && node -e {json.dumps(node)}' 2>/dev/null | tail -1"],
        capture_output=True, text=True, timeout=180,
    )
    return out.stdout.strip().splitlines()[-1].strip()


def visit(path, cookies=None, agent=BROWSER, follow=False):
    s = requests.Session()
    s.headers["User-Agent"] = agent
    for name, value in (cookies or {}).items():
        s.cookies.set(name, value, domain=HOST)
    r = s.get(f"{BASE}{path}", timeout=45, allow_redirects=follow)
    return r


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    bd = signed_country_cookie("BD")
    results, ok = [], True

    def check(name, passed, detail=""):
        nonlocal ok
        results.append({"check": name, "pass": bool(passed), "detail": detail})
        if not passed:
            ok = False
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))

    # 1. A visitor in Bangladesh, first ever request.
    r = visit("/", cookies={"vh_cc": bd})
    check("Bangladesh is redirected", r.status_code == 302, f"HTTP {r.status_code}")
    check("...to the Bangla address", (r.headers.get("location") or "").startswith("/bn"),
          r.headers.get("location") or "(no location)")

    # 2. And is offered English on the page it lands on.
    r = visit("/bn/", cookies={"vh_cc": bd}, follow=True)
    body = r.text
    check("the Bangla page offers English", 'id="lang-offer"' in body)
    check("the offer links to the English switch", "/lang/en" in body)
    check("the offer is not the old Bangla one", "বাংলায় দেখুন" not in body or "Read in English" in body)

    # 3. Somebody who has chosen English is left alone, wherever they are.
    r = visit("/", cookies={"vh_cc": bd, "vh_lang": "en"})
    check("a chosen language is never overridden", r.status_code == 200, f"HTTP {r.status_code}")

    # 4. A visitor from elsewhere is unaffected.
    r = visit("/", cookies={"vh_cc": signed_country_cookie("GB")})
    check("elsewhere still gets English", r.status_code == 200, f"HTTP {r.status_code}")

    # 5. A crawler is never redirected, so both languages stay indexable.
    r = visit("/", cookies={"vh_cc": bd}, agent=CRAWLER)
    check("a crawler is not redirected", r.status_code == 200, f"HTTP {r.status_code}")

    # 6. No country cookie at all: the redirect must not depend on one. From
    #    this machine the lookup answers with a non-BD country, so the correct
    #    result is 200 -- what is being checked is that it ANSWERS rather than
    #    erroring, and that no cookie is required to reach a decision.
    r = visit("/", cookies={})
    check("no cookie needed to decide", r.status_code in (200, 302), f"HTTP {r.status_code}")

    out = SHOTS / f"language-default-{STAMP}.json"
    out.write_text(json.dumps({"base": BASE, "pass": ok, "checks": results}, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    print("\n" + ("PASS" if ok else "FAIL"), "->", out)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
