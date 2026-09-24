"""Does the GoDigital bundle really cost ৳381 at the basket?

    python tool/cloud_godigital_test.py

An advert that names a price has to be right. This follows the one-click path
the offers page gives a Bangladeshi visitor -- /offers/GODIGITAL/start -- and
reads the basket back: the .site domain, the Starter month, the bundle
discount, and the total the customer would actually approve.

It also checks the offer is refused from outside Bangladesh, because the code
is advertised publicly and a code that is shown but refused is worse than no
code at all.

Nothing is ordered: the basket is a cookie.
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
CODE = "GODIGITAL"
HOST = BASE.split("//")[1]


def signed_country_cookie(cc):
    """The country cookie is HMAC-signed on the node; ask the node for one."""
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
        capture_output=True, text=True, timeout=120,
    )
    return out.stdout.strip().splitlines()[-1].strip()


def money(text):
    """Every taka figure on the page, as written."""
    return re.findall(r"৳[০-৯0-9,]+\.[০-৯0-9]{2}", text)


def run(country, currency):
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0 (Vesopa GoDigital test)"
    s.cookies.set("vh_cur", currency, domain=HOST)
    s.cookies.set("vh_cc", signed_country_cookie(country), domain=HOST)

    out = {"country": country}
    start = s.get(f"{BASE}/offers/{CODE}/start", timeout=60, allow_redirects=True)
    out["start_status"] = start.status_code
    out["landed_on"] = start.url.replace(BASE, "")

    cart = s.get(f"{BASE}/cart", timeout=60)
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", cart.text))
    out["basket_has_site_domain"] = bool(re.search(r"\.site", text))
    out["basket_mentions_code"] = CODE in text
    out["figures"] = money(text)[-6:]
    for phrase in ("That code is for customers in another country.",
                   "That code is for a first order.",
                   "Nothing in your basket qualifies for that code."):
        if phrase in text:
            out["refused_because"] = phrase
    return out


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    report = {"base": BASE, "code": CODE, "runs": []}
    for country, currency in (("BD", "BDT"), ("GB", "GBP")):
        r = run(country, currency)
        report["runs"].append(r)
        print(json.dumps(r, ensure_ascii=False).encode("ascii", "backslashreplace").decode())

    out = SHOTS / f"godigital-{STAMP}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("written to", out)


if __name__ == "__main__":
    main()
