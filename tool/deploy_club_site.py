"""A rugby club's website on the Cloud box, from GitHub Actions ("Club site").

    python tool/deploy_club_site.py LoughorRFC check     what exists, what it would do
    python tool/deploy_club_site.py LoughorRFC site      ship the site, mail and venue

The club is a folder with a website/ in it (LoughorRFC, PontardaweRFC). Runs
where port 22 is reachable: GitHub Actions (VESOPA_SSH_PASSWORD through
SSH_ASKPASS, as go-server.yml does) or the owner's PC. Plain ssh and tar.

  1. bundles <club>/website (src, public, content, package files; no
     node_modules, .env or tests) and uploads it to /root/<club>-deploy/<stamp>
  2. scripts/remote-install.sh: DNS for member., both web domains on the
     NodeJS proxy, certificates, LOYALTY_VENUE_HOSTS in the back office .env,
     the members' sign-in address in Vesopa Auth, the site's .env (keys never
     printed, the admin setup code kept on the box), npm ci, pm2 by name
  3. scripts/mail-forward.sh: info@ and contact@ forwarded to club.json
     email_forwards_to
  4. tool/club_venue.js: the club's venue in the back office (only adds)
  5. when step 2 gave the back office a new member host, restarts the back
     office by name so it reads it (never `pm2 restart all`)

The site refuses to deploy without the club's own crest artwork in
public/img (made by website/tool/make_images.py from <club>/brand/crest.png).

Prints names and statuses only: the repository's Actions logs are public.
"""
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
HOST = os.environ.get("VESOPA_SSH_HOST", "root@34.63.118.67")
USER = "vesopasoftware"
BACKOFFICE = f"/home/{USER}/web/backoffice.vesopaepos.com/private/nodeapp"
PM2 = f"su - {USER} -c 'PM2_HOME=/home/{USER}/.pm2 pm2 {{}}'"
NEEDED = ["img/crest-512.png", "img/icon-192.png", "img/icon-512.png", "img/og-home.jpg", "favicon.ico"]

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


def ssh(script, *, data=None, check=True, env=""):
    """Runs a script on the box; prints and returns its output."""
    cmd = ["ssh", "-o", "BatchMode=no", HOST, f"{env}bash -s" if data is None else script]
    r = subprocess.run(cmd, input=script.encode() if data is None else data, capture_output=True)
    out = r.stdout.decode(errors="replace")
    if out.strip():
        print(out.rstrip(), flush=True)
    if check and r.returncode:
        err = r.stderr.decode(errors="replace").strip().splitlines()[-3:]
        raise SystemExit(f"! on the server (exit {r.returncode}): {' | '.join(err)}")
    return out


def bundle(site):
    """The site and its scripts as a .tar.gz, LF line endings for bash."""
    buf = io.BytesIO()
    skip = {"node_modules", ".env", "data", "logs", "test", "tool"}
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for part in ["src", "public", "content", "package.json", "package-lock.json"]:
            tar.add(site / part, arcname=f"site/{part}",
                    filter=lambda t: None if set(pathlib.PurePosixPath(t.name).parts) & skip else t)
        for name in ["remote-install.sh", "mail-forward.sh"]:
            body = (site / "scripts" / name).read_bytes().replace(b"\r\n", b"\n")
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(body), 0o755
            tar.addfile(info, io.BytesIO(body))
        venue = (ROOT / "tool" / "club_venue.js").read_bytes()
        info = tarfile.TarInfo("club_venue.js")
        info.size = len(venue)
        tar.addfile(info, io.BytesIO(venue))
    return buf.getvalue()


def main():
    if len(sys.argv) < 3 or sys.argv[2] not in ("check", "site"):
        raise SystemExit(__doc__)
    club_dir = ROOT / sys.argv[1]
    site = club_dir / "website"
    check = sys.argv[2] == "check"
    club = json.loads((site / "content" / "club.json").read_text(encoding="utf-8"))
    domain = club["web"]["site"].split("//", 1)[1].strip("/")
    print(f"▶ {club['name']}: {domain}", flush=True)

    missing = [n for n in NEEDED if not (site / "public" / n).is_file()]
    if missing:
        msg = (f"the club's crest artwork is missing ({', '.join(missing)}): put the club's own crest in "
               f"{club_dir.name}/brand/crest.png and run {club_dir.name}/website/tool/make_images.py")
        if not check:
            raise SystemExit(f"! {msg}")
        print(f"  ! {msg}")

    remote = f"/root/{club_dir.name.lower()}-deploy/{time.strftime('%Y%m%d_%H%M%S')}"
    print(f"▶ upload to {remote}", flush=True)
    ssh(f"mkdir -p {remote} && tar -xzf - -C {remote}", data=bundle(site))

    flag = "--check" if check else ""
    print("▶ install (DNS, domains, certificates, member host, Auth address, site, pm2)", flush=True)
    before = ssh(f"grep -c '{club['web']['members'].split('//', 1)[1]}=' {BACKOFFICE}/.env || true", check=False).strip()
    ssh(f"cd {remote} && HIDE_SETUP_CODE=1 bash remote-install.sh {flag}")

    print(f"▶ mail: info@ and contact@{domain} to {club['email_forwards_to']}", flush=True)
    ssh(f"cd {remote} && bash mail-forward.sh {flag} '{club['email_forwards_to']}' '{club['email']}'", check=False)

    print(f"▶ back office venue {club.get('slug', '')}", flush=True)
    ssh(f"cd {BACKOFFICE} && node {remote}/club_venue.js {remote}/site/content/club.json {flag}")

    if check:
        print("check only: nothing changed.")
        return
    after = ssh(f"grep -c '{club['web']['members'].split('//', 1)[1]}=' {BACKOFFICE}/.env || true", check=False).strip()
    if before != after:
        print("▶ back office: reload for the new member host", flush=True)
        ssh(PM2.format("restart backoffice.vesopaepos.com --update-env") + " | tail -2")
    print("▶ checks", flush=True)
    ssh("sleep 4; for u in https://%s/ https://%s/club https://%s/sitemap.xml %s/; do "
        "curl -sS -o /dev/null -w \"  %%{http_code}  $u\\n\" \"$u\" || echo \"  ---  $u\"; done"
        % (domain, domain, domain, club["web"]["members"]), check=False)


if __name__ == "__main__":
    main()
