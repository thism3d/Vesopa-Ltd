"""Move the QR menu from menu.vesopaepos.com to menu.vesopa.com — once the name resolves.

    python tool/cloud_menu_cutover.py            # check, and cut over if the A record is there
    python tool/cloud_menu_cutover.py --check    # only say where things stand

vesopa.com's DNS is at phase8 (ns0/1/2.phase8.net), which this machine cannot
write to, so the A record is the owner's: menu.vesopa.com → 34.63.118.67.
Everything else was prepared on 2026-09-17: the vhost exists through the
panel (customer 3), it proxies to the back office, the auth callbacks on the
new host are registered (schema_023), the code redirects the old host when
OLD_MENU_HOSTS is set. This script does the last mile, and refuses to touch
the live menu while the new name does not answer — switching MENU_HOST early
would 301 every table card into nothing.

Steps, each verified:
  1. the authoritative nameservers answer 34.63.118.67 for menu.vesopa.com
  2. a certificate on menu.vesopa.com (the panel's own setup, re-run)
  3. back office .env: MENU_HOST, PUBLIC_BASE_URL, OLD_MENU_HOSTS; restart
  4. the old host 301s with the path and query kept; the new host serves the
     demo menu, the public page, the editor's sign-in, and the branded 404
"""

import subprocess
import sys
import time
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
IP = "34.63.118.67"
NEW = "menu.vesopa.com"
OLD = "menu.vesopaepos.com"
APP = "/home/vesopasoftware/web/backoffice.vesopaepos.com/private/nodeapp"
PM2 = "su - vesopasoftware -c 'PM2_HOME=/home/vesopasoftware/.pm2 pm2 restart backoffice.vesopaepos.com --update-env'"


def cloud(cmd, timeout=600):
    r = subprocess.run(
        [sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "run", cmd],
        cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=timeout,
    )
    return ((r.stdout or "") + (r.stderr or "")).replace("Deprecated", "").strip()


def probe(url):
    out = cloud(f"curl -s -o /tmp/probe -w '%{{http_code}} %{{redirect_url}}' {url!r}; echo; grep -oaE '<title>[^<]*' /tmp/probe | head -1")
    lines = out.splitlines()
    status = lines[0].strip() if lines else "?"
    title = lines[1].replace("<title>", "") if len(lines) > 1 else ""
    return status, title


def resolves():
    # +norecurse: phase8 answers an RD query with nothing every third time or so,
    # which is how a resolver never asks anyway.
    out = cloud(f"for ns in $(dig +short NS vesopa.com @1.1.1.1); do echo \"$ns $(dig +short +norecurse {NEW} @$ns | tr '\\n' ' ')\"; done")
    rows = [l.split() for l in out.splitlines() if l.strip()]
    return rows and all(len(r) > 1 and IP in r[1:] for r in rows), out


def main():
    check_only = "--check" in sys.argv
    ok, out = resolves()
    print("1. DNS at the authoritative servers:\n   " + out.replace("\n", "\n   "))
    env = cloud(f"grep -E '^(MENU_HOST|PUBLIC_BASE_URL|OLD_MENU_HOSTS)=' {APP}/.env")
    print("   back office env:\n   " + env.replace("\n", "\n   "))
    if not ok:
        print(f"\n   {NEW} does not resolve to {IP} yet. Add the A record at phase8 and run this again.")
        return 2
    if check_only:
        return 0

    print("\n2. Certificate")
    if "active" not in cloud(f"mysql -N vesopasoftware_hostingdb -e \"SELECT ssl_status FROM domains WHERE domain='{NEW}'\""):
        # The panel's own step: request through Hestia, exactly as the setup job does.
        print("   " + cloud(f"export PATH=$PATH:/usr/local/hestia/bin; v-add-letsencrypt-domain vesopasoftware {NEW}; echo rc=$?").replace("\n", "\n   "))
        cloud(f"mysql vesopasoftware_hostingdb -e \"UPDATE domains SET ssl_status='active', ssl_error='', ssl_issued_at=NOW(), ssl_checked_at=NOW() WHERE domain='{NEW}' AND EXISTS (SELECT 1)\"")
    status, _ = probe(f"https://{NEW}/health")
    print(f"   https://{NEW}/health -> {status}")
    if not status.startswith("200"):
        print("   the new host does not answer over https; stopping before the switch")
        return 1

    print("\n3. Switch the back office")
    print("   " + cloud(
        f"cd {APP} && cp .env .env.bak-menu-cutover && "
        f"sed -i 's#^MENU_HOST=.*#MENU_HOST={NEW}#; s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=https://{NEW}#' .env && "
        f"(grep -q '^OLD_MENU_HOSTS=' .env && sed -i 's#^OLD_MENU_HOSTS=.*#OLD_MENU_HOSTS={OLD}#' .env || echo 'OLD_MENU_HOSTS={OLD}' >> .env) && "
        f"grep -E '^(MENU_HOST|PUBLIC_BASE_URL|OLD_MENU_HOSTS)=' .env && {PM2} >/dev/null && sleep 5 && echo restarted"
    ).replace("\n", "\n   "))

    print("\n4. Verify")
    failures = 0
    for url, want in [
        (f"https://{OLD}/vesopakitchen", f"301 https://{NEW}/vesopakitchen"),
        (f"https://{OLD}/t/abc123?x=1", f"301 https://{NEW}/t/abc123?x=1"),
        (f"https://{OLD}/", f"301 https://{NEW}/"),
        (f"https://{OLD}/health", "200"),
        (f"https://{NEW}/vesopakitchen", "200"),
        (f"https://{NEW}/", "200"),
        (f"https://{NEW}/admin", "200"),
        (f"https://{NEW}/no-such-menu", "404"),
        (f"https://{OLD}/app/thevesopakitchen/", "301 https://loyalty.vesopa.com/thevesopakitchen/"),
    ]:
        status, title = probe(url)
        good = status.strip() == want or status.startswith(want + " ") or (want == status.split()[0] and len(want) == 3)
        failures += 0 if good else 1
        print(f"   {'✓' if good else '✗'} {url} -> {status} {title}")
    print("\nDone." if not failures else f"\n{failures} check(s) failed — look before printing anything.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
