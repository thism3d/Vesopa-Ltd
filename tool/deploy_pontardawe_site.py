"""Put pontardawerfc.com and member.pontardawerfc.com live (2026-10-10).

    python tool/deploy_pontardawe_site.py --check    what exists, what it would do
    python tool/deploy_pontardawe_site.py            set up what is missing, then ship

Run from the repository root on the owner's Windows folder (cloud sessions
cannot reach port 22). It:

  1. bundles PontardaweRFC/website (no node_modules, no .env, no tests, no
     source photos) and uploads it to /root/pontardawe-deploy/<stamp>
  2. runs PontardaweRFC/website/scripts/remote-install.sh there, which is
     idempotent: the member A record, both web domains on the NodeJS proxy,
     certificates, LOYALTY_VENUE_HOSTS in the back office .env, the members'
     app sign-in address in Vesopa Auth, the site's .env (keys never printed),
     npm ci, pm2 "pontardawerfc.com" by name, checks
  3. scripts/mail-forward.sh: info@ and contact@pontardawerfc.com forwarded
     to the club's old address (club.json email_forwards_to); an Exim
     redirect, no mailbox. The SMTP2GO relay takes it only once
     pontardawerfc.com is a verified sender domain there
  4. (not with --check) the members' web app (vesopa_loyalty, flutter build
     web --base-href /__SLUG__/; the build already in vesopa_loyalty/build/web
     when Flutter is not installed) to the back office's loyalty_web, the old
     one kept in backup/loyalty_web.pre-member-look
  5. (not with --check) tool/deploy_memberships.py --backoffice: the back
     office code with collection orders, the member host and the club's look
     there (src/venue_looks.js), its schema (re-runnable) and its restart

Rolling back the site: `pm2 stop pontardawerfc.com` as vesopasoftware puts the
old "site is ready" page back; the back office changes are additive, and the
previous members' web app is in backup/loyalty_web.pre-member-look.
"""
import json
import os
import pathlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
SITE = ROOT / "PontardaweRFC" / "website"
sys.path.insert(0, str(ROOT / "tool"))
import deploy_memberships as dm  # noqa: E402  (loads .env.claude, the ssh helper)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


def bundle():
    stage = pathlib.Path(tempfile.mkdtemp(prefix="pontardawe-"))
    site = stage / "site"
    site.mkdir()
    shutil.copytree(SITE / "src", site / "src")
    shutil.copytree(SITE / "public", site / "public")
    (site / "content").mkdir()
    for f in (SITE / "content").glob("*.json"):
        shutil.copy(f, site / "content" / f.name)
    for name in ["package.json", "package-lock.json"]:
        shutil.copy(SITE / name, site / name)
    # LF endings whatever the checkout did, or bash on the box stops at "$'\r'".
    script = (SITE / "scripts" / "remote-install.sh").read_bytes().replace(b"\r\n", b"\n")
    (stage / "remote-install.sh").write_bytes(script)
    forward = (SITE / "scripts" / "mail-forward.sh").read_bytes().replace(b"\r\n", b"\n")
    (stage / "mail-forward.sh").write_bytes(forward)
    return stage


def web_build():
    """The members' web app, built for every venue's address (loyalty_app.js writes the venue in)."""
    app = ROOT / "vesopa_loyalty"
    flutter = shutil.which("flutter")
    if flutter:
        print("▶ build the members' web app")
        subprocess.run([flutter, "build", "web", "--release", "--base-href", "/__SLUG__/"], cwd=str(app), check=True)
    web = app / "build" / "web"
    packed = app / "build" / "web.zip"
    if not flutter and packed.exists() and (not web.exists() or packed.stat().st_mtime > web.stat().st_mtime):
        # A build made elsewhere and copied here as one file.
        print("▶ unpack the members' web app (build/web.zip)")
        shutil.rmtree(web, ignore_errors=True)
        shutil.unpack_archive(str(packed), str(web))
    index = web / "index.html"
    if not index.exists() or '<base href="/__SLUG__/">' not in index.read_text(encoding="utf-8"):
        raise SystemExit("no members' web build: install Flutter, or build it with --base-href /__SLUG__/")
    return web


def main():
    check = "--check" in sys.argv
    stage = bundle()
    remote = f"/root/pontardawe-deploy/{time.strftime('%Y%m%d_%H%M%S')}"
    try:
        print(f"▶ upload to {remote}")
        dm.ssh("put", str(stage), remote)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    print("▶ install (DNS, domains, certificates, back office host, Auth address, site, pm2)")
    dm.ssh("run", f"cd {remote} && bash remote-install.sh {'--check' if check else ''}")
    print("▶ info@pontardawerfc.com, forwarded to the club's old address (no mailbox)")
    club = json.loads((SITE / "content" / "club.json").read_text(encoding="utf-8"))
    dm.ssh("run", f"cd {remote} && bash mail-forward.sh {'--check' if check else ''} {shlex.quote(club['email_forwards_to'])}", check=False)
    if check:
        print("check only: nothing changed. Run again without --check.")
        return
    web = web_build()
    print("▶ members' web app")
    dm.ssh("run", f"cd {dm.BACKOFFICE} && mkdir -p backup && rm -rf backup/loyalty_web.pre-member-look "
                  "&& cp -a loyalty_web backup/loyalty_web.pre-member-look")
    dm.ssh("put", str(web), f"{dm.BACKOFFICE}/loyalty_web")
    dm.ssh("run", f"chown -R {dm.USER}:{dm.USER} {dm.BACKOFFICE}/loyalty_web")
    print("▶ back office (collection orders, the member host, the club's look)")
    dm.backoffice()
    dm.ssh("run",
           "sleep 5; "
           "curl -sS -o /dev/null -w 'back office health        %{http_code}\\n' https://backoffice.vesopaepos.com/health; "
           "curl -sS -o /dev/null -w 'member.pontardawerfc.com  %{http_code}\\n' https://member.pontardawerfc.com/; "
           "curl -sS https://member.pontardawerfc.com/ | grep -q 'vesopa-look' && echo 'members site has the club look' || echo 'members site: no club look yet'; "
           "curl -sS -o /dev/null -w 'old members link          %{http_code} -> %{redirect_url}\\n' https://loyalty.vesopa.com/pontardawe-rfc/; "
           "curl -sS -o /dev/null -w 'pontardawerfc.com         %{http_code}\\n' https://pontardawerfc.com/; "
           "curl -sS -o /dev/null -w 'menu API for the site     %{http_code} (404 until the menu is published)\\n' https://menu.vesopa.com/api/public/dinein/venue/pontardawe-rfc",
           check=False)


if __name__ == "__main__":
    main()
