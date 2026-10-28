"""go.vesopa.com: Vesopa Go's own pages (home, privacy, terms, support), from
vesopa_go/web/site, onto the Vesopa Cloud box. Run by .github/workflows/go-site.yml
over SSH (VESOPA_SSH_PASSWORD, askpass, set up by the workflow).

    python vesopa_go/tool/go_site.py check    # where the site lives and what it serves; changes nothing
    python vesopa_go/tool/go_site.py live     # back up, upload, HTTPS if missing, check

The repository and its logs are public: this prints the domain, counts and
status codes only. Nothing on the server is deleted: the site's folder is
backed up first, and files are only added or replaced.
"""
import io
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SITE = REPO / "vesopa_go" / "web" / "site"
HOST = "root@34.63.118.67"
DOMAIN = "go.vesopa.com"
H = "export PATH=$PATH:/usr/local/hestia/bin; "
PAGES = ["/", "/privacy/", "/terms/", "/support/", "/style.css"]


def sh(script, *, data=None, check=True):
    cmd = ["ssh", "-o", "BatchMode=no", HOST, "bash -s" if data is None else script]
    r = subprocess.run(cmd, input=script.encode() if data is None else data, capture_output=True)
    if check and r.returncode:
        raise SystemExit(f"! on the server (exit {r.returncode})")
    return r.stdout.decode(errors="replace").strip()


def status(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "go-site"}), timeout=20) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def where():
    """The Hestia user and folder that serve the domain (exactly one)."""
    found = sh(f"ls -d /home/*/web/{DOMAIN}/public_html 2>/dev/null || true").split()
    if len(found) != 1:
        raise SystemExit(f"! {DOMAIN}: {len(found)} web folders on the box (expected 1). Add the domain in Vesopa Cloud first.")
    folder = found[0]
    user = folder.split("/")[2]
    return user, folder


def main(mode):
    files = [p for p in SITE.rglob("*") if p.is_file()]
    print(f"== {DOMAIN}: {len(files)} files in vesopa_go/web/site")
    user, folder = where()
    print(f"  served from a Hestia web domain (folder found, {sh(f'ls -A {folder} | wc -l')} entries now)")
    ssl = sh(H + f"v-list-web-domain {user} {DOMAIN} shell 2>/dev/null | awk '$1==\"SSL:\"{{print $2}}' || true")
    print(f"  HTTPS: {ssl or 'unknown'}")
    for page in PAGES:
        print(f"  https://{DOMAIN}{page}: {status(f'https://{DOMAIN}{page}')}")
    if mode != "live":
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"/home/{user}/backups/go-site-{stamp}.tgz"
    sh(f"mkdir -p /home/{user}/backups && chmod 700 /home/{user}/backups && tar -czf {backup} -C {folder} . && chown {user}:{user} {backup}")
    print(f"== backup\n  {backup}")

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for p in files:
            tar.add(p, arcname=p.relative_to(SITE).as_posix())
    sh(f"cd {folder} && tar -xzf - --no-same-owner && chown -R {user}:{user} {folder} && find {folder} -type d -exec chmod 755 {{}} + && find {folder} -type f -exec chmod 644 {{}} +",
       data=buf.getvalue())
    print(f"== upload\n  {len(files)} files up")

    if ssl.lower() != "yes":
        out = sh(H + f"v-add-letsencrypt-domain {user} {DOMAIN} '' yes >/dev/null 2>&1 && echo ok || echo failed", check=False)
        print(f"== HTTPS\n  Let's Encrypt: {out}")

    time.sleep(3)
    print("== check")
    bad = 0
    for page in PAGES:
        code = status(f"https://{DOMAIN}{page}")
        bad += code != 200
        print(f"  https://{DOMAIN}{page}: {code}")
    if bad:
        raise SystemExit(f"! {bad} pages did not answer 200")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "check")
