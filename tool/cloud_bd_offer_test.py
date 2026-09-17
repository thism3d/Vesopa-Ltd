"""Does the Bangladesh offer actually work at the basket, and only there?

    python tool/cloud_bd_offer_test.py

The offers page can say anything; what matters is what the checkout agrees to.
This puts a real hosting plan in a basket on the live site and applies
BANGLADESH40 twice -- once as an ordinary visitor and once as a visitor the
server places in Bangladesh -- and reports the discount each time.

Expected: refused for everyone else, 40% off for Bangladesh, and the taka
price shown to a Bangladeshi visitor.

Nothing is ordered: the basket is a cookie and is thrown away with the session.
"""

import datetime
import json
import pathlib
import re
import sys

import requests

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://cloud.vesopa.com").rstrip("/")
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images"
STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
CODE = "BANGLADESH40"
UA = "Mozilla/5.0 (Vesopa BD offer test)"


def csrf(session, url):
    html = session.get(url, timeout=30).text
    m = re.search(r'name="_csrf"\s+value="([^"]+)"', html) or re.search(r'value="([^"]+)"\s+name="_csrf"', html)
    return (m.group(1) if m else session.cookies.get("vh_csrf") or ""), html


def run(country):
    """One visitor, start to discount. `country` is '' for anyone else."""
    s = requests.Session()
    s.headers["User-Agent"] = UA
    host = BASE.split("//")[1]
    # A currency cookie is set FIRST on purpose. The server only runs a geo
    # lookup for a visitor who has not got one, and that lookup rewrites the
    # country cookie -- so without this the test's own "I am in Bangladesh"
    # was overwritten by this machine's real address on the very first page,
    # and both runs came back refused. A real Bangladeshi visitor carries both
    # cookies after their first page, which is what this reproduces.
    if country:
        s.cookies.set("vh_cur", "BDT", domain=host)
        s.cookies.set("vh_cc", country, domain=host)
    else:
        s.cookies.set("vh_cur", "USD", domain=host)
        s.cookies.set("vh_cc", "GB", domain=host)

    out = {"country": country or "(elsewhere)"}

    # A hosting plan, picked off the live pricing page rather than hardcoded.
    token, html = csrf(s, f"{BASE}/hosting")
    slug = None
    m = re.search(r'/order/([a-z0-9-]+)\?term=12', html)
    if m:
        slug = m.group(1)
    out["plan"] = slug
    if not slug:
        out["error"] = "no plan link found on /hosting"
        return out

    s.get(f"{BASE}/order/{slug}?term=12", timeout=30)

    token, cart_html = csrf(s, f"{BASE}/cart")
    # The basket total, not just any symbol on the page -- the currency picker
    # lists every active currency, so "is there a taka sign anywhere" is always
    # true now that BDT is switched on.
    m = re.search(r'(?:Total|Subtotal)[^<]*</[^>]*>\s*<[^>]*>\s*([^<]+)', cart_html)
    out["basket_total"] = m.group(1).strip() if m else "?"

    # Apply the code the way the basket form does.
    r = s.post(
        f"{BASE}/cart/coupon",
        data={"_csrf": token, "code": CODE},
        headers={"Referer": f"{BASE}/cart", "Origin": BASE},
        timeout=30,
        allow_redirects=True,
    )
    out["status"] = r.status_code
    body = r.text
    out["applied"] = CODE in body and ("Discount" in body or "discount" in body)
    # The message the basket gives back, whichever way it went.
    for pattern in (
        r"That code is for customers in another country\.",
        r"That code is for a first order\.",
        r"That code is not one of ours\.",
        r"Nothing in your basket qualifies for that code\.",
        r"That code has expired\.",
    ):
        if re.search(pattern, body):
            out["refused_because"] = re.search(pattern, body).group(0)
            break
    m = re.search(r'(?:Discount|ছাড়)[^<]*</[^>]+>\s*<[^>]*>\s*(-\s*[^<]+)', body)
    if m:
        out["discount_shown"] = m.group(1).strip()
    return out


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    report = {"base": BASE, "code": CODE, "runs": [run(""), run("BD")]}
    out = SHOTS / f"bd-offer-{STAMP}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    for r in report["runs"]:
        print(json.dumps(r))
    print("written to", out)


if __name__ == "__main__":
    main()
