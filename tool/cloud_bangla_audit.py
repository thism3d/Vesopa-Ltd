"""How much English is left on the Bangla site?

    python tool/cloud_bangla_audit.py

Reads every public page in Bangla as a visitor placed in Bangladesh sees it,
and counts the lines that still carry English prose. Brand and technical words
that Bangladeshi customers use in English anyway -- Vesopa, WordPress, SSL,
DNS, IMAP, GB -- are not counted, because leaving those in English is correct,
not a gap.

WHY A SEPARATE CHECK FROM npm run i18n:check. That one compares the catalogue
against the strings the extractor found, and the extractor only sees text
inside t(). It reported "Bangla complete" while the Bangla home page showed
its plan names, its feature lists and seven FAQ answers in English, because
none of those were in t() at all -- two were in the database and the rest were
typed straight into the templates. This reads the rendered page instead, which
is the only thing that cannot lie about what a customer sees.
"""

import datetime
import json
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://cloud.vesopa.com").rstrip("/")
SHOTS = pathlib.Path.home() / "Documents" / "Vesopa-Claude-Images"
STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")

PAGES = [
    "/bn/", "/bn/hosting", "/bn/email", "/bn/domains", "/bn/domains/pricing",
    "/bn/ssl", "/bn/transfer", "/bn/support", "/bn/about", "/bn/contact",
    "/bn/offers", "/bn/build",
]

# Words that stay in English on purpose.
KEEP = {
    "vesopa", "wordpress", "ssl", "dns", "nvme", "imap", "smtp", "pop", "spf",
    "dkim", "dmarc", "whois", "cname", "srv", "aaaa", "txt", "ttl", "php",
    "mysql", "ftp", "sftp", "ssh", "api", "html", "css", "json", "url", "http",
    "https", "tls", "sslcommerz", "stripe", "paypal", "bkash", "nagad", "git",
    "starter", "business", "pro", "claude", "cursor", "lovable", "azure",
    "microsoft", "google", "cloudflare", "plesk", "cpanel", "directadmin",
    "isp", "icann", "ips", "seo", "cms", "vps", "cdn", "wales", "baglan",
    "port", "talbot", "ltd", "epos", "software", "limited", "email", "lite",
    "essentials", "marketing", "webmail", "staging", "toolkit",
    # Extensions and example hostnames. These appear inside Bangla sentences
    # (".online আর .shop-এ", "shop.yourdomain.co.uk") and are names, not
    # English prose -- counting them reported a finished page as unfinished.
    "online", "shop", "store", "site", "tech", "space", "blog", "club", "app",
    "dev", "cloud", "yourdomain", "yourbusiness", "yourbakery", "example",
    "com", "net", "org", "uk", "info", "biz", "xyz", "wales",
}


def english_words(line):
    words = re.findall(r"[A-Za-z][A-Za-z'’]{2,}", line)
    return [w for w in words if w.lower() not in KEEP]


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    report, worst = {}, 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, bypass_csp=True)
        host = BASE.split("//")[1]
        ctx.add_cookies([
            {"name": "vh_cc", "value": "BD", "domain": host, "path": "/"},
            {"name": "vh_cur", "value": "BDT", "domain": host, "path": "/"},
        ])
        page = ctx.new_page()
        for path in PAGES:
            res = page.goto(BASE + path, wait_until="networkidle")
            page.wait_for_timeout(600)
            text = page.evaluate(
                "() => { const m = document.querySelector('main'); return m ? m.innerText : ''; }"
            )
            lines = []
            for line in text.split("\n"):
                line = line.strip()
                if not line:
                    continue
                # Three or more ordinary English words is a sentence that was missed.
                if len(english_words(line)) >= 3:
                    lines.append(line[:110])
            report[path] = {"status": res.status if res else 0, "english": lines}
            worst = max(worst, len(lines))
            print(f"  {path:22} {res.status if res else '---'}  english lines: {len(lines)}")
            for l in lines[:3]:
                print("        ", l.encode("ascii", "backslashreplace").decode()[:100])
        browser.close()

    out = SHOTS / f"bangla-audit-{STAMP}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(len(v["english"]) for v in report.values())
    print(f"\n{total} English line(s) across {len(PAGES)} Bangla pages")
    print("written to", out)
    return 0 if total == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
