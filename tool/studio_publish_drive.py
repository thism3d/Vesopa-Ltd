"""Publish a Vesopa Studio site for real, onto a scratch subdomain, then take it all away.

    python tool/studio_publish_drive.py [site.json]

Customer 5 only (the developer's own muzahid@onzep.uk -- never 3 or 6). The
scratch name carries a timestamp and the run refuses to start if it exists,
so clean-up only ever removes what this run created:

  1. add studio-test-<stamp>.<parent> through the panel's own form, and wait
     for its setup job to make it a website
  2. publish a Studio site onto it: the server answers with the address and
     where the previous page (Hestia's default) was kept
  3. the page is served by the node: index.html from Studio, and its CSS
  4. the Studio source reads back from the domain's private folder
  5. publish again: the first version becomes the backup, the page changes
  6. finally, always: remove the subdomain through the panel, delete the
     backups this run made, and check nothing of the scratch name is left
"""

import datetime
import json
import pathlib
import re
import subprocess
import sys
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = "https://cloud.vesopa.com"
NODE_IP = "34.63.118.67"
CUSTOMER_ID = 5
passed = failed = 0

MINT = (
    "cd @app && su - vesopasoftware -c 'cd /home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp && "
    "node -e \"require(\\\"dotenv\\\").config(); const db=require(\\\"./src/db\\\"),auth=require(\\\"./src/auth\\\"); "
    f"db.one(\\\"SELECT * FROM customers WHERE id={CUSTOMER_ID}\\\").then(c=>{{auth.issueCustomerSession({{cookie:(n,v)=>console.log(\\\"COOKIE \\\"+v)}},c);process.exit(0)}})\"'"
)


def check(label, ok, detail=""):
    global passed, failed
    print(f"  {'✓' if ok else '✗'} {label}{'' if ok else ' — ' + str(detail)[:300]}")
    passed += bool(ok)
    failed += (not ok)


def ssh(cmd):
    r = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "run", cmd], cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", capture_output=True)
    return r.stdout


def fetch(host, scheme, path="/"):
    r = subprocess.run(["curl", "-sk", "--max-time", "20", "-D", "-", "--resolve", f"{host}:443:{NODE_IP}", "--resolve", f"{host}:80:{NODE_IP}", f"{scheme}://{host}{path}"], text=True, encoding="utf-8", errors="replace", capture_output=True)
    return r.stdout


def diagnose(host):
    """What is on disk, and what each scheme answers -- printed, for when the page is not what was published."""
    print("   disk:", ssh(f"ls -la /home/*/web/{host}/public_html/ 2>&1 | head -8; head -c 300 /home/*/web/{host}/public_html/index.html").strip()[:900])
    for scheme in ("http", "https"):
        out = fetch(host, scheme)
        head = out.split("\r\n\r\n", 1)[0].replace("\r\n", " | ")[:300]
        title = (re.search(r"<title>([^<]*)</title>", out) or [None, ""])[1]
        print(f"   {scheme}: {head} || title={title!r}")


def fetch_site(host):
    """The page as the node serves it, whatever public DNS says yet: http, then https."""
    for scheme in ("http", "https"):
        out = fetch(host, scheme)
        body = out.split("\r\n\r\n", 1)[-1]
        if "<html" in body.lower() and " 30" not in out.split("\r\n", 1)[0]:
            return body
    return ""


def wait_job(session, status_path, timeout=360):
    """Until the domain's setup job says finished. The node reloads nginx while
    it issues a certificate, so a dropped connection here is expected: retry."""
    end = time.time() + timeout
    while status_path and time.time() < end:
        try:
            if session.get(f"{BASE}{status_path}", timeout=20).json().get("finished"):
                return True
        except (requests.RequestException, ValueError):
            pass
        time.sleep(4)
    return False


site_file = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(r"C:\vtts\studio\bakery2.json")
site = json.loads(site_file.read_text(encoding="utf-8"))
site["name"] = "Studio publish test"

token = next((l.split(" ", 1)[1].strip() for l in ssh(MINT).splitlines() if l.startswith("COOKIE ")), "")
if not token:
    raise SystemExit("could not mint a session")
s = requests.Session()
s.cookies.set("vh_session", token, domain="cloud.vesopa.com")
s.get(f"{BASE}/panel")
csrf = s.cookies.get("vh_csrf")
ai_token = s.get(f"{BASE}/ai/session").json()["token"]
H = {"x-csrf-token": csrf, "x-ai-token": ai_token, "origin": BASE}

domains = s.get(f"{BASE}/ai/build/domains").json()
print("publishable before:", [d["domain"] for d in domains.get("domains", [])])
parents = [d["domain"] for d in domains.get("domains", []) if d["domain"].count(".") == 1]
if not parents:
    raise SystemExit("customer 5 has no top-level website to hang a scratch subdomain off")
parent = "vesopa.site" if "vesopa.site" in parents else parents[0]
stamp = datetime.datetime.now().strftime("%m%d%H%M%S")
scratch = f"studio-test-{stamp}.{parent}"
page = s.get(f"{BASE}/panel/domains").text
if scratch in page:
    raise SystemExit(f"{scratch} already exists; refusing to touch it")

domain_id = None
status_path = None
backups = []
try:
    print(f"▶ add {scratch} through the panel")
    form = s.get(f"{BASE}/panel/domains/add").text
    service = re.search(r'name="service_id"[\s\S]*?<option value="(\d+)"', form)
    r = s.post(f"{BASE}/panel/domains/add", data={"_csrf": csrf, "domain": scratch, "service_id": service.group(1) if service else ""}, allow_redirects=True)
    m = re.search(r"/panel/domains/([^/?#]+)$", r.url)
    domain_id = m.group(1) if m else None
    check("the panel accepted it", bool(domain_id), r.url)
    # Wait for the setup JOB to finish, not just for the domain to look ready:
    # the first full run removed the subdomain while its job was still going,
    # and the job then put the website and its A record back (activity log,
    # 14:07:55 removed, 14:08:02 verified again).
    found = re.search(r'data-status-url="([^"]+)"', s.get(r.url).text)
    status_path = found.group(1) if found else None
    check("its setup job finished", wait_job(s, status_path), status_path or "no status url on the page")
    ready = any(d["domain"] == scratch for d in s.get(f"{BASE}/ai/build/domains").json().get("domains", []))
    check("and made it a website", ready)

    print("▶ publish")
    t = time.time()
    r = s.post(f"{BASE}/ai/build/publish", headers=H, json={"domain": scratch, "site": site, "confirm": True})
    out = r.json()
    print(f"   {r.status_code} in {time.time() - t:.1f}s: {out}")
    check("published", r.status_code == 200 and out.get("ok"), out)
    check("the default page was kept, not deleted", bool(out.get("backup")), out.get("backup"))
    if out.get("backup"):
        backups.append(out["backup"])
    refused = s.post(f"{BASE}/ai/build/publish", headers=H, json={"domain": scratch, "site": site})
    check("publishing without the tick is refused", refused.status_code == 400, refused.status_code)
    other = s.post(f"{BASE}/ai/build/publish", headers=H, json={"domain": "example.com", "site": site, "confirm": True})
    check("publishing to a domain that is not theirs is refused", other.status_code in (403, 400), (other.status_code, other.text[:120]))

    html = fetch_site(scratch)
    ok = "Vesopa Studio" in html and "Studio publish test" in html
    if not ok:
        diagnose(scratch)
    check("the node serves the Studio page", ok, html[:200])
    css = subprocess.run(["curl", "-sk", "--max-time", "20", "--resolve", f"{scratch}:443:{NODE_IP}", "--resolve", f"{scratch}:80:{NODE_IP}", "-L", f"http://{scratch}/assets/vesopa-site.css"], text=True, encoding="utf-8", errors="replace", capture_output=True).stdout
    check("and its stylesheet", ".v-hero" in css, css[:120])

    src = s.get(f"{BASE}/ai/build/source", params={"domain": scratch})
    check("the source reads back for editing", src.status_code == 200 and src.json()["site"]["name"] == "Studio publish test", src.text[:160])

    print("▶ publish again")
    site["name"] = "Studio publish test, second version"
    r = s.post(f"{BASE}/ai/build/publish", headers=H, json={"domain": scratch, "site": site, "confirm": True})
    out2 = r.json()
    print(f"   {r.status_code}: {out2}")
    check("republished", r.status_code == 200 and out2.get("ok"), out2)
    if out2.get("backup"):
        backups.append(out2["backup"])
    check("the first version became a backup", bool(out2.get("backup")) and out2.get("backup") != out.get("backup"), out2.get("backup"))
    html2 = fetch_site(scratch)
    if "second version" not in html2:
        diagnose(scratch)
    check("the page changed", "second version" in html2, html2[:200])
finally:
    print("▶ clean up")
    if domain_id:
        # Never remove while the setup job runs: it puts the website back.
        wait_job(s, status_path)
        r = s.post(f"{BASE}/panel/domains/{domain_id}/remove", data={"_csrf": csrf}, allow_redirects=True)
        print("   removed:", r.status_code, r.url)
    names = [b.rsplit("/", 1)[-1] for b in backups]
    safe = [n for n in names if re.fullmatch(r"public_html-studio-test-\d{10}\.[a-z0-9.-]+-\d{14}", n)]
    for n in safe:
        print("   ", ssh(f"for d in /home/*/.vesopa/replaced/'{n}'; do [ -e \"$d\" ] && rm -rf -- \"$d\" && echo deleted \"$d\"; done").strip())
    time.sleep(3)
    left_domains = s.get(f"{BASE}/ai/build/domains").json().get("domains", [])
    check("the scratch subdomain is gone from the account", not any(d["domain"] == scratch for d in left_domains))
    left = ssh(f"ls -d /home/*/web/{scratch} /home/*/.vesopa/replaced/public_html-{scratch}-* 2>/dev/null; echo end").strip()
    check("nothing of it is left on the node", left == "end", left)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
