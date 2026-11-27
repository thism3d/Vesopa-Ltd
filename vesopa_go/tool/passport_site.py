"""passport.vesopa.com: Vesopa Passport (owner, 2026-11-26: "passport.vesopa.com
is in the cloud.vesopa.com ... only verification and account opening goes
there"), from vesopa_go/web/passport plus the files it shares with
go.vesopa.com (style, accent, the sign-up code, icons), onto the Vesopa Cloud
box. Run by .github/workflows/go-site.yml over SSH (askpass, set up there).

    python vesopa_go/tool/passport_site.py check   # what is there now; changes nothing
    python vesopa_go/tool/passport_site.py live    # domain if missing, back up, upload, HTTPS, check

Made as a panel user does it, never by changing the panel or the mail set-up
(standing rule: "Do not alter coding in cloud Vesopa or mailbox, only create
everything being a user"): the web domain under the same Hestia user as
go.vesopa.com with the panel's own v-add-web-domain, a DNS record with
v-add-dns-record when vesopa.com's zone is on the box, and a Let's Encrypt
certificate with v-add-letsencrypt-domain. Nothing on the server is deleted.

The repository and its logs are public: this prints domains, counts and
status codes only.
"""
import io
import socket
import sys
import tarfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import go_site  # noqa: E402  (same folder: sh, status, the box's address)

REPO = Path(__file__).resolve().parents[2]
PASSPORT = REPO / "vesopa_go" / "web" / "passport"
SITE = REPO / "vesopa_go" / "web" / "site"
SHARED = ["style.css", "favicon.png", "js/accent.js", "js/signup.js", "img/go-mark.png", "img/apple-touch-icon.png"]
DOMAIN = "passport.vesopa.com"
ZONE = "vesopa.com"
IP = go_site.HOST.split("@", 1)[1]
H = go_site.H
PAGES = ["/", "/flow/", "/passport.css", "/style.css", "/js/signup.js", "/js/passport-config.js", "/js/accent.js", "/img/go-mark.png"]
sh, status = go_site.sh, go_site.status


def files():
    out = {p.relative_to(PASSPORT).as_posix(): p for p in PASSPORT.rglob("*") if p.is_file()}
    for rel in SHARED:
        out.setdefault(rel, SITE / rel)
    missing = [k for k, p in out.items() if not p.exists()]
    if missing:
        raise SystemExit(f"! missing in the repository: {', '.join(missing)}")
    return out


def go_user():
    found = sh("ls -d /home/*/web/go.vesopa.com/public_html 2>/dev/null || true").split()
    if len(found) != 1:
        raise SystemExit(f"! go.vesopa.com: {len(found)} web folders on the box (expected 1)")
    return found[0].split("/")[2]


def zone_owner():
    found = sh(f"ls -d /home/*/conf/dns/{ZONE}.db 2>/dev/null || true").split()
    return found[0].split("/")[2] if len(found) == 1 else None


def resolves():
    try:
        return sorted({a[4][0] for a in socket.getaddrinfo(DOMAIN, 443, proto=socket.IPPROTO_TCP)})
    except OSError:
        return []


def main(mode):
    tree = files()
    print(f"== {DOMAIN}: {len(tree)} files ({len(SHARED)} shared with go.vesopa.com)")
    user = go_user()
    folder = f"/home/{user}/web/{DOMAIN}/public_html"
    there = sh(f"test -d {folder} && echo yes || true") == "yes"
    owner = zone_owner()
    print(f"  web domain on the box: {'yes' if there else 'not yet'} (same panel user as go.vesopa.com)")
    print(f"  {ZONE} DNS on the box: {'yes' if owner else 'no (elsewhere)'}")
    print(f"  {DOMAIN} resolves to: {', '.join(resolves()) or 'nothing yet'} (the box is {IP})")
    for page in PAGES:
        print(f"  https://{DOMAIN}{page}: {status(f'https://{DOMAIN}{page}')}")
    if mode != "live":
        return

    print("== domain")
    if owner:
        rec = sh(H + f"v-list-dns-records {owner} {ZONE} plain | awk '$2==\"passport\" {{print $3\" \"$4}}'", check=False)
        if rec:
            print(f"  DNS: passport {rec}")
        else:
            sh(H + f"v-add-dns-record {owner} {ZONE} passport A {IP}")
            print(f"  DNS: passport A {IP} added")
    elif IP not in resolves():
        print(f"  DNS for {ZONE} is not on the box: an A record passport -> {IP} is needed where {ZONE}'s DNS is kept")
    if not there:
        sh(H + f"v-add-web-domain {user} {DOMAIN} {IP} no")
        print("  web domain: added")
    else:
        print("  web domain: there")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"/home/{user}/backups/passport-site-{stamp}.tgz"
    sh(f"mkdir -p /home/{user}/backups && chmod 700 /home/{user}/backups && tar -czf {backup} -C {folder} . && chown {user}:{user} {backup}")
    print(f"== backup\n  {backup}")

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel, p in sorted(tree.items()):
            tar.add(p, arcname=rel)
    sh(f"cd {folder} && tar -xzf - --no-same-owner && chown -R {user}:{user} {folder} "
       f"&& find {folder} -type d -exec chmod 755 {{}} + && find {folder} -type f -exec chmod 644 {{}} +", data=buf.getvalue())
    print(f"== upload\n  {len(tree)} files up")

    print("== HTTPS")
    ssl = lambda: '"yes"' in sh(H + f"v-list-web-domain {user} {DOMAIN} json | grep '\"SSL\"' || true", check=False)  # noqa: E731
    if ssl():
        print("  certificate: there")
    else:
        for _ in range(8):
            res = sh(H + f"v-add-letsencrypt-domain {user} {DOMAIN} '' no 2>&1 | tail -1", check=False)
            if ssl():
                print("  certificate: issued")
                break
            print(f"  certificate: not yet ({res[-90:]}); waiting for DNS")
            time.sleep(30)
        else:
            raise SystemExit(f"! no certificate: {DOMAIN} must resolve to {IP} first. The site is uploaded; run again once it does.")

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
    m = sys.argv[1] if len(sys.argv) > 1 else ""
    if m not in ("check", "live"):
        raise SystemExit(__doc__)
    main(m)
