"""menu.pontardawerfc.com, and Pontardawe RFC's own sender for app emails (2026-10-12).

    python tool/setup_pontardawe_menu.py --check   # say where things stand, change nothing
    python tool/setup_pontardawe_menu.py           # do it

Menu, the way loyalty.vesopa.com and menu.vesopa.com were added:
  1. added through the Cloud panel as the owning customer (the account that has
     pontardawerfc.com, customer 3), so it is in that account's Domains list and
     the panel's setup run writes the DNS record (the zone is on this box);
  2. proxied to the back office (the menu is served by it, like menu.vesopa.com);
  3. a Let's Encrypt certificate;
  4. the venue's QR menu (dinein_venue, slug pontardawe-rfc) told its own
     address, with the club's crest and colours where it has none: the back
     office marks the domain verified the first time a request for it arrives.

Mail: the sign-in code emails the club's app sends go from
info@pontardawerfc.com as "Pontardawe RFC". Its SMTP login is copied from the
club website's own .env on the box into the back office's .env as
LOYALTY_PONTARDAWE_RFC_* (src/mailer.js venueAccount). No value is printed.

Loads .env.claude through deploy_pontardawe_app, like the other Pontardawe tools.
"""
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import deploy_pontardawe_app as app  # noqa: E402  (loads .env.claude too)

try:
    import requests
except ImportError:  # pragma: no cover
    raise SystemExit("pip install requests")

sh = app.sh
USER = "vesopasoftware"
DOMAIN = "menu.pontardawerfc.com"
CUSTOMER = 3
PORT = 20005
SLUG = "pontardawe-rfc"
CLOUD = "https://cloud.vesopa.com"
H = "export PATH=$PATH:/usr/local/hestia/bin; "
CLOUD_APP = f"/home/{USER}/web/cloud.vesopa.com/private/nodeapp"
CLOUD_DB = (f"cd {CLOUD_APP} && set -a && . ./.env 2>/dev/null; set +a; "
            "mariadb -N -u$DB_USER -p\"$DB_PASSWORD\" $DB_NAME -e ")
BO_ENV = f"{app.BACKOFFICE}/.env"
SITE_ENV = f"/home/{USER}/web/pontardawerfc.com/private/nodeapp/.env"
MAIL_KEY = "LOYALTY_PONTARDAWE_RFC"


def out(client, cmd):
    return sh(client, cmd, quiet=True)[1].strip()


def cloud_sql(client, sql):
    return [l.split("\t") for l in out(client, CLOUD_DB + f"\"{sql}\"").splitlines() if l.strip()]


def web_domain_exists(client):
    return DOMAIN in out(client, H + f"v-list-web-domains {USER} plain | cut -f1").split()


def mint(client):
    cmd = (f"su - {USER} -c 'cd {CLOUD_APP} && node -e \"require(\\\"dotenv\\\").config(); "
           "const db=require(\\\"./src/db\\\"),auth=require(\\\"./src/auth\\\"); "
           f"db.one(\\\"SELECT * FROM customers WHERE id={CUSTOMER}\\\").then(c=>{{auth.issueCustomerSession("
           "{cookie:(n,v)=>console.log(\\\"COOKIE \\\"+v)},c);process.exit(0)})\"'")
    text = out(client, cmd)
    token = next((l.split(" ", 1)[1].strip() for l in text.splitlines() if l.startswith("COOKIE ")), "")
    if not token:
        raise SystemExit("! could not open a panel session for the customer:\n" + text[-400:])
    s = requests.Session()
    s.cookies.set("vh_session", token, domain="cloud.vesopa.com")
    return s


def panel_add(client):
    s = mint(client)
    s.get(f"{CLOUD}/panel/domains/add", timeout=60)
    r = s.post(f"{CLOUD}/panel/domains/add", data={"_csrf": s.cookies.get("vh_csrf"), "domain": DOMAIN},
               allow_redirects=False, timeout=120)
    print(f"   panel add {DOMAIN}: {r.status_code} -> {r.headers.get('location', '')}")
    for _ in range(90):
        row = cloud_sql(client, "SELECT r.status, r.headline FROM domain_setup_runs r JOIN domains d ON d.id=r.domain_id "
                                f"WHERE d.domain='{DOMAIN}' ORDER BY r.id DESC LIMIT 1")
        if row and row[0][0] != "running":
            print(f"   setup: {row[0][0]} - {row[0][1] if len(row[0]) > 1 else ''}")
            return
        time.sleep(2)
    print("   ! setup run still going after three minutes")


def dns(client):
    rec = out(client, H + f"v-list-dns-records {USER} pontardawerfc.com plain | awk '$2==\"menu\"'")
    if rec:
        print(f"   DNS: {rec.split()[2]} {rec.split()[3]}")
        return
    print("   DNS: adding menu A 34.63.118.67")
    sh(client, H + f"v-add-dns-record {USER} pontardawerfc.com menu A 34.63.118.67")


def proxy(client):
    conf = f"/home/{USER}/conf/web/{DOMAIN}/nodeapp.conf"
    sh(client,
       f"cat > {conf} <<'EOF'\nlocation / {{\n\tproxy_pass http://127.0.0.1:{PORT};\n\tproxy_http_version 1.1;\n"
       "\tproxy_set_header Upgrade $http_upgrade;\n\tproxy_set_header Connection $connection_upgrade;\n\tproxy_set_header Host $host;\n"
       "\tproxy_set_header X-Real-IP $remote_addr;\n\tproxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
       "\tproxy_set_header X-Forwarded-Proto $scheme;\n\tproxy_cache_bypass $http_upgrade;\n\tproxy_read_timeout 300s;\n}\nEOF\n"
       f"chown {USER}:{USER} {conf}")
    print("   proxy: " + out(client, H + f"v-change-web-domain-proxy-tpl {USER} {DOMAIN} NodeJS '' yes 2>&1 | tail -1") or "NodeJS template")


def certificate(client):
    if '"yes"' in out(client, H + f"v-list-web-domain {USER} {DOMAIN} json | grep '\"SSL\"'"):
        print("   certificate: already on")
        return
    for attempt in range(6):
        res = out(client, H + f"v-add-letsencrypt-domain {USER} {DOMAIN} '' no 2>&1 | tail -2")
        if '"yes"' in out(client, H + f"v-list-web-domain {USER} {DOMAIN} json | grep '\"SSL\"'"):
            print("   certificate: issued")
            return
        print(f"   certificate: not yet ({res[-120:]}); waiting for DNS")
        time.sleep(30)


def venue(client):
    db = app.DB
    q = (f"UPDATE dinein_venue v LEFT JOIN epos_loyalty_app a ON a.slug = '{SLUG}' "
         f"SET v.custom_domain = '{DOMAIN}', v.domain_verified = 0, "
         "v.logo_url = COALESCE(NULLIF(v.logo_url, ''), NULLIF(a.icon_url, ''), NULLIF(a.logo_url, '')) "
         f"WHERE v.slug = '{SLUG}' AND (v.custom_domain IS NULL OR v.custom_domain <> '{DOMAIN}' OR v.logo_url IS NULL)")
    sh(client, f"{db} -e \"{q}\"")
    sh(client, f"{db} -e \"SELECT slug, custom_domain, domain_verified, is_published, ordering_open, logo_url FROM dinein_venue WHERE slug = '{SLUG}'\"")


def mail(client):
    have = out(client, f"grep -cE '^{MAIL_KEY}_SMTP_(USER|PASSWORD)=' {BO_ENV} || true")
    if have.strip() == "2":
        print("   venue mailbox: already in the back office .env")
        return False
    script = rf"""
set -eu
S={SITE_ENV}; B={BO_ENV}
get() {{ grep -E "^$1=" "$S" | tail -1 | cut -d= -f2-; }}
[ -n "$(get SMTP_USER)" ] && [ -n "$(get SMTP_PASS)" ] || {{ echo '  ! the club site has no SMTP login'; exit 1; }}
cp -p "$B" "$B.bak_pre_venue_mail_$(date +%Y%m%d_%H%M%S)"
python3 - "$B" "$S" <<'PY'
import sys
bo, site = sys.argv[1:]
vals = dict(l.split('=', 1) for l in open(site).read().splitlines() if '=' in l and not l.startswith('#'))
want = {{
    '{MAIL_KEY}_SMTP_HOST': vals.get('SMTP_HOST', ''),
    '{MAIL_KEY}_SMTP_PORT': vals.get('SMTP_PORT', '587'),
    '{MAIL_KEY}_SMTP_SECURE': vals.get('SMTP_SECURE', 'false'),
    '{MAIL_KEY}_SMTP_USER': vals.get('SMTP_USER', ''),
    '{MAIL_KEY}_SMTP_PASSWORD': vals.get('SMTP_PASS', ''),
    '{MAIL_KEY}_MAIL_FROM': vals.get('SMTP_USER', ''),
    '{MAIL_KEY}_MAIL_FROM_NAME': 'Pontardawe RFC',
}}
lines = [l for l in open(bo).read().splitlines() if l.split('=', 1)[0] not in want]
lines += [f'{{k}}={{v}}' for k, v in want.items()]
open(bo, 'w').write('\n'.join(lines) + '\n')
PY
chown {USER}:{USER} "$B"; chmod 600 "$B"
echo "  venue mailbox: $(grep -c '^{MAIL_KEY}_' "$B") keys saved (values not shown)"
"""
    sh(client, script)
    return True


def fetch(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "vesopa-check"}), timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return getattr(e, "code", 0), str(e)


def main():
    check = "--check" in sys.argv
    client = app.vesopa_ssh.connect()
    try:
        print(f"== {DOMAIN}")
        exists = web_domain_exists(client)
        print(f"   web domain on the box: {'yes' if exists else 'no'}")
        print(f"   panel row: {cloud_sql(client, f'SELECT id, customer_id, status, ssl_status FROM domains WHERE domain=' + chr(39) + DOMAIN + chr(39))}")
        if check:
            sh(client, f"{app.DB} -e \"SELECT slug, custom_domain, domain_verified, logo_url FROM dinein_venue WHERE slug = '{SLUG}'\"")
            print("   venue mailbox keys: " + out(client, f"grep -cE '^{MAIL_KEY}_' {BO_ENV} || true"))
            return
        if not exists:
            panel_add(client)
        dns(client)
        if not web_domain_exists(client):
            print("   adding the web domain directly (the panel run did not)")
            sh(client, H + f"v-add-web-domain {USER} {DOMAIN} 34.63.118.67 no 2>&1 | tail -2")
        proxy(client)
        certificate(client)
        venue(client)
        print("\n== app emails from info@pontardawerfc.com")
        if mail(client):
            sh(client, app.PM2.format("restart backoffice.vesopaepos.com --update-env") + " >/dev/null && echo '   back office restarted'")
    finally:
        client.close()
    time.sleep(5)
    st, body = fetch(f"https://{DOMAIN}/")
    print(f"   https://{DOMAIN}/ -> {st} {'Pontardawe' in body and 'shows the club menu' or body[:120]}")


if __name__ == "__main__":
    main()
