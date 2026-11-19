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
  4. tool/club_venue.js with <club>/backoffice.json: the club's venue in the
     back office (only adds): its login with the owner's password, every
     module, Go seats, the members' app, a starter bar and kitchen, the online
     menu, tickets, the app stores' review member and the Wallet card
  5. the club's Wallet artwork and icons into the back office, and its app in
     the back office .env lists (APNS_TOPICS, LOYALTY_IOS_APPS,
     GOOGLE_WALLET_ORIGINS) where those are set
  6. the back office restarted by name when its .env changed (never
     `pm2 restart all`), then the club's Google Wallet pass classes made at
     Google
  7. Vesopa accounts (backoffice.json accounts.vesopa) with the owner's
     password and every venue application, and the Vesopa mailbox
     (accounts.mailbox) on this box when its domain's mail is here

The password comes from CLUB_ACCOUNT_PASSWORD (the workflow's secret for the
club). It goes to the box on stdin into a mode-600 file that is deleted at the
end; it is never on a command line or printed.

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
AUTH = f"/home/{USER}/web/auth.vesopa.com/private/nodeapp"
AUTH_SCRIPTS = ["create-person.js", "set-password.js", "grant-venue-apps.js"]
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
        data = site.parent / "backoffice.json"
        if data.is_file():
            tar.add(data, arcname="backoffice.json")
        for name in AUTH_SCRIPTS:
            tar.add(ROOT / "vesopa_auth" / "scripts" / name, arcname=f"auth/{name}")
        slug = json.loads((site / "content" / "club.json").read_text(encoding="utf-8")).get("slug", "")
        server = ROOT / "vesopa_server"
        for src, dest in [(server / "assets" / "wallet" / "looks" / slug, "looks"),
                          (server / "public" / "assets" / "venues" / slug, "venue-assets")]:
            if slug and src.is_dir():
                tar.add(src, arcname=dest)
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

    # The mail server's own set-up (Exim routers) is changed only when asked
    # for (owner, 2026-11-19: "Do not alter coding in cloud Vesopa or
    # mailbox, only create everything being a user"). Loughor's forwarding
    # was set up once, on 2026-11-19; set MAIL_FORWARD=1 to run it again.
    if os.environ.get("MAIL_FORWARD") == "1":
        print(f"▶ mail: info@ and contact@{domain} to {club['email_forwards_to']}", flush=True)
        ssh(f"cd {remote} && bash mail-forward.sh {flag} '{club['email_forwards_to']}' '{club['email']}'", check=False)
    else:
        print("▶ mail: the mail server's set-up is left as it is (MAIL_FORWARD=1 to change it)", flush=True)

    slug = club.get("slug", "")
    data = json.loads((club_dir / "backoffice.json").read_text(encoding="utf-8")) if (club_dir / "backoffice.json").is_file() else {}
    password = os.environ.get("CLUB_ACCOUNT_PASSWORD", "")
    pw = f"{remote}/.pw"
    if password:
        ssh(f"umask 077 && cat > {pw}", data=password.encode())
    elif data.get("accounts"):
        print("  ! no CLUB_ACCOUNT_PASSWORD: the logins keep their passwords (new ones get a random one)")
    try:
        print(f"▶ back office venue {slug}", flush=True)
        data_arg = f"{remote}/backoffice.json" if data else ""
        ssh(f"cd {BACKOFFICE} && CLUB_PASSWORD_FILE={pw} node {remote}/club_venue.js {remote}/site/content/club.json {data_arg} {flag}")

        print("▶ back office: the club's artwork and app", flush=True)
        app_id = data.get("app_id") or club["web"].get("android_package", "")
        members = club["web"]["members"].rstrip("/")
        site_url = club["web"]["site"].rstrip("/")
        env_script = f"""
set -e
E={BACKOFFICE}/.env
changed=0
addto() {{ # addto KEY VALUE: append to a comma list that is already set
  if grep -q "^$1=" "$E"; then
    if grep -E "^$1=" "$E" | grep -qF "$2"; then echo "  ✓ $1 has $2"
    elif [ "{flag}" = "--check" ]; then echo "  ! would add $2 to $1"
    else sed -i "s|^$1=\\(.*\\)$|$1=\\1,$2|" "$E"; echo "  ▶ $1 gains $2"; changed=1; fi
  else echo "  - $1 not set on this server: skipped"; fi
}}
addto APNS_TOPICS "{slug}={app_id}"
addto LOYALTY_IOS_APPS "G238FR2ZC9.{app_id}"
addto GOOGLE_WALLET_ORIGINS "{members}"
addto GOOGLE_WALLET_ORIGINS "{site_url}"
if [ "{flag}" != "--check" ]; then
  if [ -d {remote}/looks ]; then mkdir -p {BACKOFFICE}/assets/wallet/looks/{slug} && cp -a {remote}/looks/. {BACKOFFICE}/assets/wallet/looks/{slug}/; fi
  if [ -d {remote}/venue-assets ]; then mkdir -p {BACKOFFICE}/public/assets/venues/{slug} && cp -a {remote}/venue-assets/. {BACKOFFICE}/public/assets/venues/{slug}/; fi
  chown -R {USER}:{USER} {BACKOFFICE}/assets/wallet/looks {BACKOFFICE}/public/assets/venues 2>/dev/null || true
  echo "  ✓ Wallet artwork and icons in place"
fi
echo "changed=$changed"
"""
        out = ssh(env_script) if slug and app_id else ""

        # Google Wallet on the back office, the first time (owner, 2026-11-19:
        # "We now have the access of Google Wallet Pass api"): the issuer and
        # the service account that signs the passes, as Back office - patch's
        # google-wallet setting does, when the server has none yet. The key
        # file sits beside the app, mode 600; nothing is printed.
        issuer = os.environ.get("GOOGLE_WALLET_ISSUER_ID", "").strip()
        sa_json = os.environ.get("GOOGLE_WALLET_SA_JSON", "").strip()
        has = ssh(f"grep -c '^GOOGLE_WALLET_ISSUER_ID=.' {BACKOFFICE}/.env || true", check=False).strip()
        if has not in ("", "0"):
            print("  ✓ Google Wallet is set up on the back office")
        elif not (issuer and sa_json):
            print("  ! Google Wallet is not set up on the back office, and the workflow has no "
                  "GOOGLE_WALLET_ISSUER_ID / PLAY_SERVICE_ACCOUNT_JSON secrets to set it up with")
        elif check:
            print("  ! would set up Google Wallet on the back office (issuer and service account from the secrets)")
        else:
            sa = f"/home/{USER}/web/backoffice.vesopaepos.com/private/google-wallet-sa.json"
            ssh(f"umask 077 && cat > {sa} && chown {USER}:{USER} {sa}", data=sa_json.encode())
            origins = ",".join(dict.fromkeys([
                "https://backoffice.vesopaepos.com", "https://loyalty.vesopa.com", "https://member.pontardawerfc.com",
                members, site_url]))
            ssh(f"""E={BACKOFFICE}/.env; cp -p $E $E.bak-$(date +%s)
setkey() {{ if grep -q "^$1=" $E; then sed -i "s|^$1=.*|$1=$2|" $E; else printf '%s=%s\\n' "$1" "$2" >> $E; fi; echo "  ▶ .env: $1 set"; }}
setkey GOOGLE_WALLET_ISSUER_ID "$(cat)"
setkey GOOGLE_WALLET_SA_FILE "{sa}"
setkey GOOGLE_WALLET_ORIGINS "{origins}"
""", data=issuer.encode())
            out += "\nchanged=1"

        if check:
            print("check only: nothing changed.")
            return
        after = ssh(f"grep -c '{members.split('//', 1)[1]}=' {BACKOFFICE}/.env || true", check=False).strip()
        if before != after or "changed=1" in out:
            print("▶ back office: restart by name for its new settings", flush=True)
            ssh(PM2.format("restart backoffice.vesopaepos.com --update-env") + " | tail -2")
            ssh("sleep 6", check=False)
        if data.get("wallet"):
            print("▶ Google Wallet: the club's pass classes", flush=True)
            ssh(f"cd {BACKOFFICE} && node {remote}/club_venue.js {remote}/site/content/club.json {data_arg} --wallet", check=False)

        accounts = data.get("accounts") or {}
        for email in accounts.get("vesopa", []):
            print(f"▶ Vesopa account {email}", flush=True)
            ssh(f"cd {AUTH} && for f in {' '.join(AUTH_SCRIPTS)}; do cp {remote}/auth/$f scripts/$f; done && chown {USER}:{USER} scripts/*.js && "
                f"node scripts/create-person.js '{email}' '{club['name']}'"
                + (f" && VESOPA_SET_PASSWORD_FILE={pw} node scripts/set-password.js '{email}'" if password else "")
                + f" && node scripts/grant-venue-apps.js '{email}'", check=False)
        box = accounts.get("mailbox")
        if box and password:
            local, box_domain = box.split("@", 1)
            print(f"▶ mailbox {box}", flush=True)
            ssh(f"""export PATH=$PATH:/usr/local/hestia/bin
owner=$(v-search-domain-owner {box_domain} mail 2>/dev/null || true)
mx=$(dig +short MX {box_domain} | sort -n | awk '{{print $2}}' | head -1)
mxip=$(dig +short "$mx" | tail -1); here=$(curl -fsS https://api.ipify.org 2>/dev/null || true)
if [ -z "$owner" ]; then echo "  ! {box_domain} is not a mail domain on this box: make {box} where {box_domain}'s mail is hosted ($mx)"
elif v-list-mail-account "$owner" {box_domain} {local} >/dev/null 2>&1; then v-change-mail-account-password "$owner" {box_domain} {local} "$(cat {pw})" && echo "  ✓ {box}: password set"
else v-add-mail-account "$owner" {box_domain} {local} "$(cat {pw})" && echo "  ✓ {box} created on this box (panel user $owner)"; fi
# The mailbox is on Vesopa Cloud (owner, 2026-11-19: "Vesopa mailbox is also
# hosted in cloud Vesopa com"); say where the domain's public MX points.
if [ -n "$mxip" ] && [ "$mxip" != "$here" ]; then echo "  ! note: {box_domain}'s MX is $mx, so mail from outside reaches this mailbox only once the MX points at Vesopa Cloud"; fi
""", check=False)
    finally:
        ssh(f"rm -f {pw}", check=False)

    print("▶ checks", flush=True)
    ssh("sleep 4; for u in https://%s/ https://%s/club https://%s/sitemap.xml %s/ https://menu.vesopa.com/api/public/dinein/venue/%s; do "
        "curl -sS -o /dev/null -w \"  %%{http_code}  $u\\n\" \"$u\" || echo \"  ---  $u\"; done"
        % (domain, domain, domain, club["web"]["members"], slug), check=False)


if __name__ == "__main__":
    main()
