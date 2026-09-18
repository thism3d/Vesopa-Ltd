"""Is the offer right in BOTH languages, on the live site?

    python tool/cloud_offers_lang_test.py

The offers page is the one page built to sell to Bangladeshi customers, so it
is the one page where a half-translated screen costs something. This reads it
as a Bangladeshi visitor in English and again in Bangla, and reports:

  * that the offer appears at all, with its code and its discount
  * that the Bangla page carries NO leftover English from this page's own copy
    -- including the headline and description, which come from the coupon row
    and so cannot come from the translation catalogue
  * that the artwork loads in both

It also reads the page as a visitor outside Bangladesh, where the offer must
not appear at all: a code shown to somebody the basket will refuse is worse
than no offer.

Output is kept in Documents/Vesopa-Claude-Images.
"""

import datetime
import json
import pathlib
import re
import subprocess
import sys

import requests

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://cloud.vesopa.com").rstrip("/")
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images"
STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
CODE = "BANGLADESH40"

# English that must NOT survive on the Bangla page. Everything here is this
# page's own copy; the words Bangladeshi customers say in English anyway
# (Vesopa, SSLCommerz, bKash as a brand) are deliberately not in the list.
ENGLISH_ON_BN = [
    "Your first year of hosting",
    "Pay in taka, get your business online",
    "Use code",
    "Start an order",
    "Applies to hosting plans.",
    "First order only.",
    "For customers in Bangladesh.",
    "No offer is running just now",
    "Pay the way you already pay",
    "Read it in Bangla",
    "Enter the code in the basket",
    "priced for Bangladesh",
]


def strip_tags(html):
    html = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))


_COOKIE_CACHE = {}


def signed_country_cookie(cc):
    """A country cookie the server will actually believe.

    The value is HMAC-signed on the node, so a plain "BD" is rejected and the
    visitor reads as being nowhere -- which hides every country-locked offer
    and made this test report the site broken when it was the test that was
    wrong. Ask the node to mint one rather than re-implementing the signature
    here, where it would drift the first time the salt changed.
    """
    if cc in _COOKIE_CACHE:
        return _COOKIE_CACHE[cc]
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
    value = out.stdout.strip().splitlines()[-1].strip()
    _COOKIE_CACHE[cc] = value
    return value


def fetch(path, country, currency):
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (Vesopa offers language test)"
    host = BASE.split("//")[1]
    # Both cookies, so no geo lookup runs and overwrites the country (it did
    # exactly that the first time this kind of test was written).
    s.cookies.set("vh_cur", currency, domain=host)
    s.cookies.set("vh_cc", signed_country_cookie(country), domain=host)
    r = s.get(f"{BASE}{path}", timeout=40)
    return r.status_code, r.text


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    report = {"base": BASE, "checks": []}
    ok = True

    def check(name, passed, detail=""):
        nonlocal ok
        report["checks"].append({"check": name, "pass": bool(passed), "detail": detail})
        if not passed:
            ok = False
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))

    # ---- English, from Bangladesh -------------------------------------------
    status, html = fetch("/offers", "BD", "BDT")
    text = strip_tags(html)
    check("English page loads", status == 200, f"HTTP {status}")
    check("English shows the code", CODE in text)
    check("English shows the discount", "40%" in text)
    check("English headline", "Your first year of hosting" in text)
    check("English artwork", "offers/bangladesh.svg" in html)
    report["english_extract"] = text[text.find("40%"):text.find("40%") + 320] if "40%" in text else ""

    # ---- Bangla, from Bangladesh --------------------------------------------
    status, html_bn = fetch("/bn/offers", "BD", "BDT")
    text_bn = strip_tags(html_bn)
    check("Bangla page loads", status == 200, f"HTTP {status}")
    check("Bangla shows the code", CODE in text_bn)
    check("Bangla shows the discount", "40%" in text_bn)
    check("Bangla headline is Bangla", "প্রথম বছরের হোস্টিং" in text_bn)
    check("Bangla artwork", "offers/bangladesh.svg" in html_bn)
    check("page is marked as Bangla", 'lang="bn"' in html_bn)

    leftovers = [e for e in ENGLISH_ON_BN if e in text_bn]
    check("no English left on the Bangla page", not leftovers, ", ".join(leftovers[:4]))
    report["bangla_leftovers"] = leftovers
    i = text_bn.find("40%")
    report["bangla_extract"] = text_bn[i:i + 320] if i >= 0 else ""

    # ---- Anyone else ---------------------------------------------------------
    for path, label in (("/offers", "English"), ("/bn/offers", "Bangla")):
        status, html_gb = fetch(path, "GB", "GBP")
        t = strip_tags(html_gb)
        check(f"{label}: offer hidden outside Bangladesh", CODE not in t, "code was visible" if CODE in t else "")

    out = SHOTS / f"offers-lang-{STAMP}.json"
    report["pass"] = ok
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n" + ("PASS" if ok else "FAIL"), "->", out)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
