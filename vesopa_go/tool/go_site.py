"""go.vesopa.com: Vesopa Go's own pages (home, privacy, terms, support), from
vesopa_go/web/site, onto the Vesopa Cloud box. Run by .github/workflows/go-site.yml
over SSH (VESOPA_SSH_PASSWORD, askpass, set up by the workflow).

    python vesopa_go/tool/go_site.py check    # where the site lives and what it serves; changes nothing
    python vesopa_go/tool/go_site.py live     # back up, upload, HTTPS if missing, check
    python vesopa_go/tool/go_site.py live --local   # the same from the office PC

The repository and its logs are public: this prints the domain, counts and
status codes only. Nothing on the server is deleted: the site's folder is
backed up first, and files are only added or replaced.
"""
import io
import re
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
# Every page of the site (each folder's index.html), then the files the pages need.
PAGES = ["/"] + sorted(f"/{p.parent.relative_to(SITE).as_posix()}/" for p in SITE.glob("*/index.html") if p.parent.name != "preview") + [
    "/.well-known/apple-app-site-association", "/robots.txt", "/sitemap.xml",
    "/js/signup.js", "/js/signup-config.js", "/style.css", "/css/premium.css",
    "/js/go.js", "/js/premium.js", "/js/extras.js", "/js/three.min.js", "/media/pay-iphone.mp4",
    "/img/og.jpg", "/img/shots/tv-02-kitchen.webp",
]
# The install page's version labels belong to publish_install.py, which stamps
# them on the server with each build; an upload of the site keeps the server's.
INSTALL_LABELS = {
    "install/index.html": [r'<p class="version">[^<]*</p>', r'<p class="version-android">[^<]*</p>', r'<p class="version-tv">[^<]*</p>'],
    "install/manifest.plist": [r"<key>bundle-version</key><string>[^<]*", r"<key>title</key><string>[^<]*"],
}
# --local: from the office PC through paramiko rather than the runner's ssh.
LOCAL = "--local" in sys.argv


_client = None


def _local_client():
    """From the office PC (--local): password SSH through paramiko, with the
    login from .env.claude-tools, as .claude/skills/vesopa-ops does."""
    global _client
    if _client is None:
        sys.path.insert(0, str(REPO / ".claude" / "skills" / "vesopa-ops" / "scripts"))
        import vesopa_ssh
        _client = vesopa_ssh.connect()
    return _client


def sh(script, *, data=None, check=True):
    if LOCAL:
        stdin, stdout, _ = _local_client().exec_command("bash -s" if data is None else script, timeout=600)
        stdin.write(script.encode() if data is None else data)
        stdin.channel.shutdown_write()
        out = stdout.read()
        code = stdout.channel.recv_exit_status()
    else:
        cmd = ["ssh", "-o", "BatchMode=no", HOST, "bash -s" if data is None else script]
        r = subprocess.run(cmd, input=script.encode() if data is None else data, capture_output=True)
        out, code = r.stdout, r.returncode
    if check and code:
        raise SystemExit(f"! on the server (exit {code})")
    return out.decode(errors="replace").strip()


def status(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "go-site"}), timeout=20) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def page(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "go-site"}), timeout=20) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        return ""


def keep_live_labels(name, local, folder):
    """The local file with the server's version labels put back in."""
    live = sh(f"cat {folder}/{name} 2>/dev/null || true", check=False)
    text = local.decode("utf-8")
    kept = 0
    for pattern in INSTALL_LABELS[name]:
        m = re.search(pattern, live)
        if m and re.search(pattern, text):
            text = re.sub(pattern, lambda _: m.group(0), text, count=1)
            kept += 1
    return text.encode("utf-8"), kept


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
    bad = 0
    for path in PAGES:
        code = status(f"https://{DOMAIN}{path}")
        bad += code != 200
        print(f"  https://{DOMAIN}{path}: {code}")
    shown = re.findall(r'<p class="version[^"]*">([^<]*)</p>', page(f"https://{DOMAIN}/install/"))
    print(f"  /install shows: {' | '.join(shown) or 'no versions'} (iPhone | Android | Android TV)")
    if mode != "live":
        if bad:
            print(f"  ! {bad} of {len(PAGES)} did not answer 200: 'live' uploads what the repo has")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"/home/{user}/backups/go-site-{stamp}.tgz"
    sh(f"mkdir -p /home/{user}/backups && chmod 700 /home/{user}/backups && tar -czf {backup} -C {folder} . && chown {user}:{user} {backup}")
    print(f"== backup\n  {backup}")

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for p in files:
            name = p.relative_to(SITE).as_posix()
            if name in INSTALL_LABELS:
                data, kept = keep_live_labels(name, p.read_bytes(), folder)
                print(f"  {name}: {kept} version label(s) kept from the server")
                info = tarfile.TarInfo(name)
                info.size, info.mtime, info.mode = len(data), int(p.stat().st_mtime), 0o644
                tar.addfile(info, io.BytesIO(data))
            else:
                tar.add(p, arcname=name)
    sh(f"cd {folder} && tar -xzf - --no-same-owner && chown -R {user}:{user} {folder} && find {folder} -type d -exec chmod 755 {{}} + && find {folder} -type f -exec chmod 644 {{}} +",
       data=buf.getvalue())
    print(f"== upload\n  {len(files)} files up")

    if ssl.lower() != "yes":
        out = sh(H + f"v-add-letsencrypt-domain {user} {DOMAIN} '' yes >/dev/null 2>&1 && echo ok || echo failed", check=False)
        print(f"== HTTPS\n  Let's Encrypt: {out}")

    time.sleep(3)
    print("== check")
    bad = 0
    for path in PAGES:
        code = status(f"https://{DOMAIN}{path}")
        bad += code != 200
        print(f"  https://{DOMAIN}{path}: {code}")
    if bad:
        raise SystemExit(f"! {bad} pages did not answer 200")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    main(args[0] if args else "check")
