"""How every hosted domain answers on HTTP and HTTPS, before and after.

    python tool/cloud_ssl_sweep_check.py before
    python tool/cloud_ssl_sweep_check.py after

The owner's standing rule (2026-09-17) is that every Vesopa-hosted domain
redirects HTTP to HTTPS. Turning that on touches live customer sites and live
API endpoints, so this records what each one does first, and again afterwards,
and prints anything whose HTTPS answer changed.

HTTP is expected to change (200 -> 301). HTTPS must NOT change: if a site
answered 200 before it must answer 200 after. An API host that starts failing
on HTTPS is the thing to catch.

Results are kept in Documents/Vesopa-Claude-Images.
"""

import concurrent.futures
import datetime
import json
import pathlib
import sys

import requests

WHERE = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images"
PHASE = (sys.argv[1] if len(sys.argv) > 1 else "before").lower()
OUT = WHERE / f"ssl-sweep-{PHASE}.json"

DOMAINS = [
    "panel.vesopa.com", "vesopa.com", "vesopasoftware.com", "vesopasolar.com",
    "assets.vesopa.com", "cloud.vesopa.com", "phpmyadmin.vesopa.com",
    "epos.vesopa.com", "pay.vesopa.com", "auth.vesopa.com", "vesopaepos.com",
    "vesopaepos.co.uk", "backoffice.vesopaepos.com", "menu.vesopaepos.com",
    "gift.vesopaepos.com", "staging.backoffice.vesopaepos.com",
    "qr.vesopaepos.com", "hosting.vesopaepos.com", "epos.vesopa.co.uk",
    "company.vesopa.co.uk", "software.vesopa.co.uk", "loyalty.vesopa.com",
    "gift.vesopa.com", "menu.vesopa.com", "thevesopakitchen.vesopaepos.com",
    "test.vesopa.com", "heat6.com", "shop.heat6.com", "test.heat6.com",
    "vesopa.site", "muzahid.com.bd", "onzep.uk", "muzahidislam.com",
    "onzep.cloud", "amzro.com", "bosheboshe.com", "aishiislam.com",
    "dreamitinstitute.com", "arpi.site", "sheve.site", "voiceodnation.site",
    "api.pasificgrowth.site", "pasificgrowth.site", "royalgrow.work",
    "api.royalgrow.work",
]


def probe(domain):
    row = {"domain": domain}
    for scheme in ("http", "https"):
        try:
            r = requests.get(
                f"{scheme}://{domain}/",
                timeout=25,
                allow_redirects=False,
                headers={"User-Agent": "Mozilla/5.0 (Vesopa SSL sweep check)"},
            )
            row[scheme] = r.status_code
            row[scheme + "_to"] = r.headers.get("location", "")
        except Exception as err:
            row[scheme] = f"ERROR {type(err).__name__}"
            row[scheme + "_to"] = ""
    return row


def main():
    WHERE.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        rows = list(pool.map(probe, DOMAINS))
    rows.sort(key=lambda r: r["domain"])
    OUT.write_text(json.dumps({"phase": PHASE, "at": datetime.datetime.now().isoformat(), "rows": rows}, indent=2), encoding="utf-8")

    for r in rows:
        print(f"  {r['domain']:34} http={str(r['http']):>14} https={str(r['https']):>14}")
    print("written to", OUT)

    if PHASE == "after":
        before_file = WHERE / "ssl-sweep-before.json"
        if not before_file.exists():
            print("no before file to compare against")
            return
        before = {r["domain"]: r for r in json.loads(before_file.read_text(encoding="utf-8"))["rows"]}
        broke, fixed = [], []
        for r in rows:
            b = before.get(r["domain"])
            if not b:
                continue
            if b["https"] != r["https"]:
                broke.append(f"{r['domain']}: https {b['https']} -> {r['https']}")
            if b["http"] != r["http"]:
                fixed.append(f"{r['domain']}: http {b['http']} -> {r['http']}")
        print("\nHTTP changed (expected 200 -> 301):")
        for line in fixed:
            print("  ", line)
        print("\nHTTPS changed (must be empty):")
        for line in broke:
            print("  ", line)
        if not broke:
            print("   none -- every site answers on HTTPS exactly as it did before")


if __name__ == "__main__":
    main()
