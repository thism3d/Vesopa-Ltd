"""Move the old AWS Hestia box (hosting.onzep.uk, 3.72.113.21) onto cloud.vesopa.com.

    python tool/migrate_old_box.py <phase> [<phase> ...]
    python tool/migrate_old_box.py all

Phases, each re-runnable:

    databases   the five databases, created through Hestia under the right
                account (names gain the account prefix) and imported
    backoffice  backoffice.vesopaepos.com + menu.vesopaepos.com — the live
                EPOS back office, as a panel Node app on the cloud box
    web         vesopaepos.com (Node), gift (Node), staging (Node)
    sites       the PHP/static sites: .co.uk, .store, qr, the three
                vesopa.co.uk subdomains; hosting.vesopaepos.com → redirect
    mail        vesopaepos.com / .co.uk / .store mailboxes, passwords and mail
    personal    the five domains into muzahid@onzep.uk: sites, DBs, mail
    dns         every record the old zones had that was not about the old
                box itself (SMTP2GO, Google, Microsoft, payments hosts)
    mailsync    ADDITIVE re-copy of every moved mailbox — run just before the
                old box is destroyed, for mail that landed there meanwhile
    check       what answers where, at the end

Domains are added THROUGH THE PANEL, as the customer, so they exist for the
panel exactly as one the customer added: a row, a job, a zone, a site, a
certificate. Files, mail and databases move over SSH from the cloud box, which
pulls from the old one with rsync. Nothing on the old box is changed.

Mapping:
    old Hestia user vesopa           → cloud user vesopasoftware (customer 3)
    old users amzro/bosheboshe/muzahid (five named domains) → u265966 (customer 5)
"""

import json
import pathlib
import re
import shlex
import subprocess
import sys
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
CLOUD = "https://cloud.vesopa.com"
OLD = "root@3.72.113.21"
SSH_OLD = f"ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new {OLD}"

# customer id → hestia user on the cloud box
ACCOUNTS = {3: "vesopasoftware", 5: "u265966"}

LOG = []


def log(msg):
    print(msg, flush=True)
    LOG.append(msg)


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

def cloud(cmd, timeout=600):
    """Run on the cloud box as root; returns stdout+stderr."""
    r = subprocess.run(
        [sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "run", cmd],
        cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=timeout,
    )
    return (r.stdout or "") + (r.stderr or "")


def old(cmd, timeout=600):
    """Run on the old box, through the cloud box's key."""
    return cloud(f"{SSH_OLD} {shlex.quote(cmd)}", timeout=timeout)


def hestia(cmd, timeout=600):
    return cloud(f"export PATH=$PATH:/usr/local/hestia/bin; {cmd}", timeout=timeout)


def rsync(src, dst, user, excludes=(), timeout=1800, delete=True):
    """Pull a tree from the old box onto the cloud box and hand it to `user`."""
    ex = " ".join(f"--exclude={shlex.quote(e)}" for e in excludes)
    out = cloud(
        f"mkdir -p {shlex.quote(dst)} && rsync -a {'--delete' if delete else ''} {ex} -e 'ssh -o BatchMode=yes' "
        f"{OLD}:{shlex.quote(src)}/ {shlex.quote(dst)}/ 2>&1 | tail -3; "
        f"chown -R {user}:{user} {shlex.quote(dst)}; du -sh {shlex.quote(dst)} | cut -f1",
        timeout=timeout,
    )
    return out.strip().splitlines()[-1] if out.strip() else "?"


# ---------------------------------------------------------------------------
# The panel, as the customer
# ---------------------------------------------------------------------------

def mint(customer_id):
    cmd = (
        "cd @app && su - vesopasoftware -c 'cd /home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp && "
        "node -e \"require(\\\"dotenv\\\").config(); const db=require(\\\"./src/db\\\"),auth=require(\\\"./src/auth\\\"); "
        f"db.one(\\\"SELECT * FROM customers WHERE id={customer_id}\\\").then(c=>{{auth.issueCustomerSession({{cookie:(n,v)=>console.log(\\\"COOKIE \\\"+v)}},c);process.exit(0)}})\"'"
    )
    out = cloud(cmd)
    token = next((l.split(" ", 1)[1].strip() for l in out.splitlines() if l.startswith("COOKIE ")), "")
    if not token:
        raise SystemExit("could not mint a panel session:\n" + out)
    s = requests.Session()
    s.cookies.set("vh_session", token, domain="cloud.vesopa.com")
    return s


def panel_add_domain(session, name, want_dns=False, want_mail=False):
    """POST the add-domain form and wait for its setup run to finish. Returns the domain row id."""
    r = session.get(f"{CLOUD}/panel/domains/add")
    csrf = session.cookies.get("vh_csrf")
    data = {"_csrf": csrf, "domain": name}
    if want_dns:
        data["want_dns"] = "1"
    if want_mail:
        data["want_mail"] = "1"
    r = session.post(f"{CLOUD}/panel/domains/add", data=data, allow_redirects=False)
    loc = r.headers.get("location", "")
    log(f"    panel add {name}: {r.status_code} → {loc}")
    # Wait for the job.
    for _ in range(90):
        row = cloud_sql(f"SELECT r.status, r.headline FROM domain_setup_runs r JOIN domains d ON d.id=r.domain_id WHERE d.domain='{name}' ORDER BY r.id DESC LIMIT 1")
        if row and row[0][0] != "running":
            log(f"    setup: {row[0][0]} — {row[0][1]}")
            break
        time.sleep(2)
    ids = cloud_sql(f"SELECT id FROM domains WHERE domain='{name}' AND status<>'removed' LIMIT 1")
    return int(ids[0][0]) if ids else None


def cloud_sql(sql):
    out = cloud(
        "cd /home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp && set -a && . ./.env 2>/dev/null; set +a; "
        f"mysql -N -u$DB_USER -p\"$DB_PASSWORD\" $DB_NAME -e {shlex.quote(sql)} 2>/dev/null"
    )
    return [line.split("\t") for line in out.strip().splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# Helpers on the boxes
# ---------------------------------------------------------------------------

def old_env_value(path, key):
    out = old(f"grep -E '^{key}=' {shlex.quote(path)} | head -1 | cut -d= -f2-")
    return out.strip().strip("'\"")


def cloud_db_exists(user, name):
    return name in hestia(f"v-list-databases {user} plain | cut -f1")


def create_db(user, suffix, dbuser_suffix, password, dump_on_old):
    full = f"{user}_{suffix}"
    if not cloud_db_exists(user, full):
        out = hestia(f"v-add-database {user} {suffix} {dbuser_suffix} {shlex.quote(password)} mysql localhost utf8mb4")
        if "Error" in out:
            log(f"    !! v-add-database {full}: {out.strip()}")
            return False
        log(f"    created {full} (user {user}_{dbuser_suffix})")
    else:
        log(f"    {full} exists")
    out = cloud(f"{SSH_OLD} cat {dump_on_old} | mysql {full} 2>&1 | tail -2; mysql -N -e 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"{full}\"'")
    log(f"    imported {dump_on_old} → {full}: {out.strip().splitlines()[-1]} tables")
    return True


def web_domain_exists(user, domain):
    return domain in hestia(f"v-list-web-domains {user} plain | cut -f1").split()


def node_app(user, domain, old_app_dir, old_env_path, db_renames, start="src/server.js", node="22", keep_modules=False):
    """Move a Node app under a domain the panel already has, as a panel Node app.

    `keep_modules`: carry node_modules as they are instead of `npm ci` — for an
    app whose generated code (a Prisma client) lives there and cannot be
    rebuilt from what ships with it. Same Node major, same platform, so it is
    exactly what ran before.
    """
    app_dir = f"/home/{user}/web/{domain}/private/nodeapp"
    excludes = ['logs', '.pm2'] + ([] if keep_modules else ['node_modules'])
    log(f"    rsync app → {app_dir}: {rsync(old_app_dir, app_dir, user, excludes=excludes)}")
    # The real .env, kept aside: v-add-nodejs-app overwrites it with a stub.
    cloud(f"cp {app_dir}/.env /root/migrate-env-{domain} 2>/dev/null")
    already = hestia(f"v-list-nodejs-apps {user} 2>/dev/null | grep -c ' {domain} \\|^{domain}\\b' || true").strip()
    out = hestia(f"v-add-nodejs-app {user} {domain} {node} {shlex.quote(start)} 2>&1 | tail -6")
    log("    " + out.strip().replace("\n", "\n    "))
    port = hestia(f"v-alloc-nodejs-port {user} {domain}").strip().splitlines()[-1]
    # Restore the real environment with the new port and database names.
    sed = "; ".join(f"s/{a}/{b}/g" for a, b in db_renames)
    cloud(
        f"cp /root/migrate-env-{domain} {app_dir}/.env && sed -i -E 's/^PORT=.*/PORT={port}/; {sed}' {app_dir}/.env "
        f"&& grep -q '^PORT=' {app_dir}/.env || echo PORT={port} >> {app_dir}/.env; chown {user}:{user} {app_dir}/.env"
    )
    install = "true" if keep_modules else "npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2"
    out = cloud(
        f"su - {user} -c 'cd {app_dir} && export PATH=/opt/nodejs/{node}/bin:$PATH && {install} "
        f"&& PM2_HOME=/home/{user}/.pm2 pm2 restart {domain} --update-env >/dev/null && PM2_HOME=/home/{user}/.pm2 pm2 save >/dev/null && echo started'",
        timeout=1200,
    )
    log("    npm/pm2: " + out.strip().splitlines()[-1])
    time.sleep(4)
    probe = cloud(f"curl -s -o /dev/null -w '%{{http_code}}' -H 'Host: {domain}' http://127.0.0.1:{port}/ ; echo; su - {user} -c 'PM2_HOME=/home/{user}/.pm2 pm2 jlist' | python3 -c 'import sys,json; [print(a[\"name\"], a[\"pm2_env\"][\"status\"], a[\"pm2_env\"].get(\"restart_time\")) for a in json.load(sys.stdin) if a[\"name\"]==\"{domain}\"]'")
    log(f"    port {port} answers: {probe.strip().replace(chr(10), ' | ')}")
    return port


def proxy_to_port(user, domain, port):
    """A second hostname served by an app that already runs (menu → back office)."""
    conf = f"/home/{user}/conf/web/{domain}/nodeapp.conf"
    cloud(
        f"cat > {conf} <<'EOF'\nlocation / {{\n\tproxy_pass http://127.0.0.1:{port};\n\tproxy_http_version 1.1;\n"
        "\tproxy_set_header Upgrade $http_upgrade;\n\tproxy_set_header Connection $connection_upgrade;\n\tproxy_set_header Host $host;\n"
        "\tproxy_set_header X-Real-IP $remote_addr;\n\tproxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "\tproxy_set_header X-Forwarded-Proto $scheme;\n\tproxy_cache_bypass $http_upgrade;\n\tproxy_read_timeout 300s;\n}\nEOF\n"
        f"chown {user}:{user} {conf}"
    )
    out = hestia(f"v-change-web-domain-proxy-tpl {user} {domain} NodeJS '' yes 2>&1 | tail -1")
    log(f"    {domain} → 127.0.0.1:{port} via NodeJS template {out.strip()}")


def static_site(user, domain, old_public_html, sed_pairs=()):
    dst = f"/home/{user}/web/{domain}/public_html"
    size = rsync(old_public_html, dst, user, excludes=[])
    if sed_pairs:
        sed = "; ".join(f"s/{a}/{b}/g" for a, b in sed_pairs)
        cloud(f"grep -rl -E '{'|'.join(a for a, _ in sed_pairs)}' {dst} --include='*.php' | xargs -r sed -i -E '{sed}'")
    log(f"    files → {dst}: {size}")


# ---------------------------------------------------------------------------
# Mail
# ---------------------------------------------------------------------------

def mail_domain(old_user, user, domain, suspended=False):
    """Recreate a mail domain with its accounts, keeping every password hash, and copy the mail."""
    have = hestia(f"v-list-mail-domains {user} plain | cut -f1").split()
    if domain not in have:
        out = hestia(f"v-add-mail-domain {user} {domain} yes yes yes 2048 yes 2>&1 | tail -1")
        log(f"    mail domain {domain}: created {out.strip()}")
    else:
        log(f"    mail domain {domain}: exists")
    accounts = old(f"export PATH=$PATH:/usr/local/hestia/bin; v-list-mail-accounts {old_user} {domain} json")
    try:
        accs = json.loads(accounts[accounts.index("{"):])
    except Exception:
        log(f"    !! could not read accounts for {domain}: {accounts[:200]}")
        return
    existing = hestia(f"v-list-mail-accounts {user} {domain} plain | cut -f1").split()
    for name, a in accs.items():
        if name not in existing:
            quota = a.get("QUOTA", "unlimited")
            quota = "unlimited" if quota in ("", "unlimited") else quota
            out = hestia(f"v-add-mail-account {user} {domain} {name} {shlex.quote('Tmp-' + str(time.time_ns()))} {quota} 2>&1 | tail -1")
            log(f"    account {name}@{domain}: created {out.strip()}")
        for alias in [x for x in (a.get("ALIAS") or "").split(",") if x]:
            hestia(f"v-add-mail-account-alias {user} {domain} {name} {alias} 2>/dev/null")
        fwd = (a.get("FWD") or "").strip()
        if fwd:
            for f in fwd.split(","):
                hestia(f"v-add-mail-account-forward {user} {domain} {name} {shlex.quote(f.strip())} 2>/dev/null")
            if a.get("FWD_ONLY") == "yes":
                hestia(f"v-add-mail-account-fwd-only {user} {domain} {name} 2>/dev/null")
    # Password hashes, carried on the box by a script that never lets a shell
    # see one (a bcrypt hash is full of `$2y$05$`, and a shell eats that).
    cloud(f"scp -q -o BatchMode=yes {OLD}:/usr/local/hestia/data/users/{old_user}/mail/{domain}.conf /root/migrate/old-mail-{domain}.conf")
    out = cloud(f"python3 /home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp/scripts/migrate-mail-passwords.py /root/migrate/old-mail-{domain}.conf {user} {domain}")
    log("    " + out.strip().splitlines()[-1])
    # The mail itself.
    for name in accs:
        size = rsync(f"/home/{old_user}/mail/{domain}/{name}", f"/home/{user}/mail/{domain}/{name}", user)
        cloud(f"chown -R {user}:mail /home/{user}/mail/{domain}/{name}")
        log(f"    mail {name}@{domain}: {size}")
    if suspended:
        hestia(f"v-suspend-mail-domain {user} {domain} no 2>/dev/null")
    hestia(f"v-rebuild-mail-domains {user} yes >/dev/null 2>&1")


# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------

def phase_databases():
    log("▶ databases")
    pw = old_env_value("/home/vesopa/web/backoffice.vesopaepos.com/private/nodeapp/.env", "DB_PASSWORD")
    create_db("vesopasoftware", "eposdb", "dbadmin", pw, "/root/migrate/vesopa_eposdb.sql")
    pw = old_env_value("/home/vesopa/web/gift.vesopaepos.com/private/nodeapp/.env", "DB_PASSWORD")
    create_db("vesopasoftware", "giftdb", "giftdb", pw, "/root/migrate/vesopa_giftdb.sql")
    pw = old_env_value("/home/vesopa/web/staging.backoffice.vesopaepos.com/private/nodeapp/.env", "DB_PASSWORD")
    create_db("vesopasoftware", "eposdb_staging", "staging", pw, "/root/migrate/vesopa_eposdb_staging.sql")


def phase_backoffice():
    log("▶ back office")
    s = mint(3)
    for name in ["backoffice.vesopaepos.com", "menu.vesopaepos.com"]:
        if not web_domain_exists("vesopasoftware", name):
            panel_add_domain(s, name)
        else:
            log(f"    {name} already on the node")
    renames = [("vesopa_eposdb", "vesopasoftware_eposdb"), ("vesopa_dbadmin", "vesopasoftware_dbadmin")]
    port = node_app("vesopasoftware", "backoffice.vesopaepos.com",
                    "/home/vesopa/web/backoffice.vesopaepos.com/private/nodeapp",
                    "/home/vesopa/web/backoffice.vesopaepos.com/private/nodeapp/.env", renames)
    proxy_to_port("vesopasoftware", "menu.vesopaepos.com", port)


def phase_web():
    log("▶ vesopaepos.com, gift, staging")
    s = mint(3)
    for name in ["gift.vesopaepos.com", "staging.backoffice.vesopaepos.com"]:
        if not web_domain_exists("vesopasoftware", name):
            panel_add_domain(s, name)
    # vesopaepos.com: the marketing site is a Node app AND has a public_html (907M of assets)
    static_site("vesopasoftware", "vesopaepos.com", "/home/vesopa/web/vesopaepos.com/public_html")
    node_app("vesopasoftware", "vesopaepos.com", "/home/vesopa/web/vesopaepos.com/private/nodeapp",
             "/home/vesopa/web/vesopaepos.com/private/nodeapp/.env",
             [("vesopa_eposdb", "vesopasoftware_eposdb"), ("vesopa_dbadmin", "vesopasoftware_dbadmin")])
    node_app("vesopasoftware", "gift.vesopaepos.com", "/home/vesopa/web/gift.vesopaepos.com/private/nodeapp",
             "/home/vesopa/web/gift.vesopaepos.com/private/nodeapp/.env",
             [("vesopa_giftdb", "vesopasoftware_giftdb")])
    node_app("vesopasoftware", "staging.backoffice.vesopaepos.com",
             "/home/vesopa/web/staging.backoffice.vesopaepos.com/private/nodeapp",
             "/home/vesopa/web/staging.backoffice.vesopaepos.com/private/nodeapp/.env",
             [("vesopa_eposdb_staging", "vesopasoftware_eposdb_staging"), ("vesopa_staging", "vesopasoftware_staging")])


def phase_sites():
    log("▶ static / PHP sites")
    s = mint(3)
    epos_renames = [("vesopa_eposdb", "vesopasoftware_eposdb"), ("vesopa_dbadmin", "vesopasoftware_dbadmin")]
    for name in ["qr.vesopaepos.com", "hosting.vesopaepos.com"]:
        if not web_domain_exists("vesopasoftware", name):
            panel_add_domain(s, name)
    for name in ["vesopaepos.store", "epos.vesopa.co.uk", "company.vesopa.co.uk", "software.vesopa.co.uk"]:
        if not web_domain_exists("vesopasoftware", name):
            panel_add_domain(s, name, want_dns=(name == "vesopaepos.store"), want_mail=(name == "vesopaepos.store"))
    static_site("vesopasoftware", "vesopaepos.co.uk", "/home/vesopa/web/vesopaepos.co.uk/public_html", epos_renames)
    static_site("vesopasoftware", "vesopaepos.store", "/home/vesopa/web/vesopaepos.store/public_html", epos_renames)
    static_site("vesopasoftware", "qr.vesopaepos.com", "/home/vesopa/web/qr.vesopaepos.com/public_html")
    for name in ["epos.vesopa.co.uk", "company.vesopa.co.uk", "software.vesopa.co.uk"]:
        static_site("vesopasoftware", name, f"/home/vesopa/web/{name}/public_html")
    # hosting.vesopaepos.com was the old copy of this very panel; it lives at cloud.vesopa.com now.
    hestia("v-add-web-domain-redirect vesopasoftware hosting.vesopaepos.com cloud.vesopa.com 301 yes 2>&1 | tail -1")
    log("    hosting.vesopaepos.com → 301 cloud.vesopa.com")


def phase_mail():
    log("▶ mail (vesopa)")
    mail_domain("vesopa", "vesopasoftware", "vesopaepos.com")
    mail_domain("vesopa", "vesopasoftware", "vesopaepos.co.uk")
    mail_domain("vesopa", "vesopasoftware", "vesopaepos.store", suspended=True)


def phase_personal():
    log("▶ muzahid@onzep.uk's five domains")
    s = mint(5)
    for name, dns, mail in [("amzro.com", True, True), ("bosheboshe.com", True, True),
                            ("aishiislam.com", True, False), ("dreamitinstitute.com", True, False)]:
        if not web_domain_exists("u265966", name):
            panel_add_domain(s, name, want_dns=dns, want_mail=mail)
        else:
            log(f"    {name} already on the node")
    # databases: passwords read from the sites' own connect files
    pw = old(r"grep -E '^$password' /home/amzro/web/amzro.com/public_html/server_files/connectserver.php | head -1 | sed -E \"s/^[^'\\\"]*['\\\"]//; s/['\\\"];? *$//\"").strip()
    if pw:
        create_db("u265966", "amzrodb", "amzrodbuser", pw, "/root/migrate/amzro_amzrodb.sql")
    else:
        log("    !! amzro DB password not found in connectserver.php")
    pw = old(r"grep -E '^$password' /home/bosheboshe/web/bosheboshe.com/public_html/connectserver.php | head -1 | sed -E \"s/^[^'\\\"]*['\\\"]//; s/['\\\"];? *$//\"").strip()
    if pw:
        create_db("u265966", "userdatabase", "udtxasd", pw, "/root/migrate/bosheboshe_userdatabase.sql")
    else:
        log("    !! bosheboshe DB password not found")
    static_site("u265966", "amzro.com", "/home/amzro/web/amzro.com/public_html",
                [("amzro_amzrodbuser", "u265966_amzrodbuser"), ("amzro_amzrodb", "u265966_amzrodb")])
    static_site("u265966", "bosheboshe.com", "/home/bosheboshe/web/bosheboshe.com/public_html",
                [("bosheboshe_udtxasd", "u265966_udtxasd"), ("bosheboshe_userdatabase", "u265966_userdatabase")])
    static_site("u265966", "aishiislam.com", "/home/muzahid/web/aishiislam.com/public_html")
    static_site("u265966", "dreamitinstitute.com", "/home/muzahid/web/dreamitinstitute.com/public_html")
    static_site("u265966", "onzep.uk", "/home/muzahid/web/onzep.uk/public_html")
    log("▶ mail (personal)")
    mail_domain("amzro", "u265966", "amzro.com")
    mail_domain("muzahid", "u265966", "onzep.uk")


def pg_database(session, user, suffix, dump_on_cloud):
    """A PostgreSQL database made through the panel's Databases page, then filled from a dump.

    The panel mints the password and shows it exactly once, on the page after
    creation — it is read from there, as the customer would read it, and the
    app's DATABASE_URL is written from it. Returns (name, password).
    """
    full = f"{user}_{suffix}"
    if full in hestia(f"v-list-databases {user} plain | cut -f1"):
        # Already made: the only way to a known password is the panel's own reset.
        session.get(f"{CLOUD}/panel/databases")
        r = session.post(f"{CLOUD}/panel/databases/reset", data={"_csrf": session.cookies.get("vh_csrf"), "name": full}, allow_redirects=True)
        log(f"    {full} exists — password reset through the panel")
    else:
        session.get(f"{CLOUD}/panel/databases")
        r = session.post(f"{CLOUD}/panel/databases/create", data={"_csrf": session.cookies.get("vh_csrf"), "name": suffix, "type": "pgsql"}, allow_redirects=True)
        log(f"    panel create {full} (pgsql): {r.status_code}")
    m = re.search(r'data-copy="postgresql://[^:]+:([^@"]+)@', r.text)
    if not m:
        raise SystemExit(f"could not read the one-time password for {full} from the page")
    password = m.group(1)
    out = cloud(
        f"su - postgres -c \"psql -d {full} -c 'CREATE EXTENSION IF NOT EXISTS ltree; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS \\\"uuid-ossp\\\";'\" 2>&1 | tail -1; "
        f"PGPASSWORD={shlex.quote(password)} psql -q -h localhost -U {full} -d {full} -v ON_ERROR_STOP=0 -f {dump_on_cloud} 2>&1 | grep -c ERROR; "
        f"su - postgres -c \"psql -Atd {full} -c \\\"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'\\\"\""
    )
    lines = out.strip().splitlines()
    log(f"    restored {dump_on_cloud} → {full}: {lines[-1] if lines else '?'} tables, {lines[-2] if len(lines) > 1 else '?'} errors")
    return full, password


CUSTOMERS = [
    # customer id, old hestia user, new hestia user, apex, old db, new db suffix, backend pm2 name
    {"id": 11, "old": "nasim", "user": "u265969", "apex": "pasificgrowth.site", "olddb": "pasificdb", "db": "pasificdb", "dbrole": "pasificgrowth"},
    {"id": 12, "old": "tradebridge", "user": "u265970", "apex": "royalgrow.work", "olddb": "royaldb", "db": "royaldb", "dbrole": "royalgrow"},
]


def phase_customers():
    """Two customers moved whole: apex + api as panel domains, PostgreSQL through the panel, both Node apps, mail."""
    for c in CUSTOMERS:
        apex, api, user, old_user = c["apex"], f"api.{c['apex']}", c["user"], c["old"]
        log(f"▶ {apex} → customer {c['id']} ({user})")
        s = mint(c["id"])
        if not web_domain_exists(user, apex):
            panel_add_domain(s, apex, want_dns=True, want_mail=True)
        if not web_domain_exists(user, api):
            panel_add_domain(s, api)
        # The database: same password the app already carries in DATABASE_URL.
        full, password = pg_database(s, user, c["db"], f"/root/migrate/backups/{c['olddb']}.sql")
        new_url = f"postgresql://{full}:{password}@localhost:5432/{full}"
        # Backend, then frontend — the frontend's default API base is the api hostname, unchanged.
        node_app(user, api, f"/home/{old_user}/web/{api}/private/nodeapp", "", [(r"^DATABASE_URL=.*$", "DATABASE_URL=" + new_url.replace("/", r"\/").replace("&", r"\&"))], start="dist/boot.js", keep_modules=True)
        node_app(user, apex, f"/home/{old_user}/web/{apex}/private/nodeapp", "", [], start="server.cjs", keep_modules=True)
        mail_domain(old_user, user, apex)


def phase_dns():
    """Records the old zones had that were about OTHER hosts — carried, never the old box's address."""
    log("▶ dns extras")
    keep = {
        "vesopaepos.com": [
            ("em730308", "CNAME", "return.smtp2go.net."), ("s730308._domainkey", "CNAME", "dkim.smtp2go.net."),
            ("link", "CNAME", "track.smtp2go.net."), ("@", "TXT", "google-site-verification=42GU2cIv_Yiuy3iryryTLbntfbE_UeW-MkIKZi6wCDg"),
            ("@", "TXT", "MS=ms81082423"), ("payments", "A", "57.159.28.41"), ("pay", "A", "3.67.10.92"),
            ("payments", "AAAA", "2603:1040:a03:19::ac"),
        ],
        "vesopaepos.co.uk": [
            ("em917242", "CNAME", "return.smtp2go.net."), ("s917242._domainkey", "CNAME", "dkim.smtp2go.net."),
            ("link", "CNAME", "track.smtp2go.net."), ("@", "TXT", "google-site-verification=8U3EmheRyquPDtg5lo05a4RuK0wyJG5E61DWN4603C0"),
        ],
        "amzro.com": [
            ("miami", "A", "172.233.174.140"), ("_domainagents", "TXT", "G6KKI2XXP7SP7P6O47SWIQMKZE"),
            ("em832309", "CNAME", "return.smtp2go.net."), ("s832309._domainkey", "CNAME", "dkim.smtp2go.net."),
            ("link", "CNAME", "track.smtp2go.net."), ("_domainkey", "TXT", '"t=y; o=~;"'), ("amzusaws", "A", "13.57.205.246"),
        ],
        "bosheboshe.com": [("_domainagents", "TXT", "G6KKI2XXP7SP7P6O47SWIQMKZE"), ("_domainkey", "TXT", '"t=y; o=~;"')],
    }
    owner = {"vesopaepos.com": "vesopasoftware", "vesopaepos.co.uk": "vesopasoftware", "amzro.com": "u265966", "bosheboshe.com": "u265966"}
    for zone, records in keep.items():
        have = hestia(f"v-list-dns-records {owner[zone]} {zone} plain 2>/dev/null")
        for name, typ, value in records:
            if re.search(rf"^\S+\s+{re.escape(name)}\s+{typ}\s+{re.escape(value.strip(chr(34)))}", have, re.M) or value in have:
                continue
            out = hestia(f"v-add-dns-record {owner[zone]} {zone} {shlex.quote(name)} {typ} {shlex.quote(value)} '' '' no 3600 2>&1 | tail -1")
            log(f"    {zone}: {name} {typ} {value[:40]} {out.strip()}")
        # every A/AAAA record that still names the old box points at this one now
        hestia(f"v-list-dns-records {owner[zone]} {zone} plain | awk '$3==\"A\" && $4==\"3.72.113.21\" {{print $1\" \"$2}}' | while read id rec; do v-change-dns-record {owner[zone]} {zone} $id \"$rec\" A 34.63.118.67 '' no 300; done")
    hestia("v-restart-dns")


def phase_mailsync():
    """RUN THIS LAST, JUST BEFORE THE OLD BOX IS DESTROYED.

    Senders whose resolvers still held the old MX kept delivering to the old
    box for up to four hours after the cutover. This pulls anything that
    arrived there since — never deleting what is here — for every mailbox
    that moved. Safe to run as often as you like.
    """
    log("▶ final mail re-sync (additive)")
    for old_user, user, domain in [("vesopa", "vesopasoftware", "vesopaepos.com"), ("vesopa", "vesopasoftware", "vesopaepos.co.uk"),
                                   ("amzro", "u265966", "amzro.com"), ("muzahid", "u265966", "onzep.uk"),
                                   ("muzahid", "u265966", "muzahidislam.com"), ("nasim", "u265969", "pasificgrowth.site"),
                                   ("tradebridge", "u265970", "royalgrow.work")]:
        for name in old(f"ls /home/{old_user}/mail/{domain}/ 2>/dev/null").split():
            size = rsync(f"/home/{old_user}/mail/{domain}/{name}", f"/home/{user}/mail/{domain}/{name}", user, delete=False)
            cloud(f"chown -R {user}:mail /home/{user}/mail/{domain}/{name}")
            log(f"    {name}@{domain}: {size}")


def phase_check():
    log("▶ check")
    for name in ["backoffice.vesopaepos.com", "menu.vesopaepos.com", "vesopaepos.com", "gift.vesopaepos.com",
                 "staging.backoffice.vesopaepos.com", "vesopaepos.co.uk", "vesopaepos.store", "qr.vesopaepos.com",
                 "hosting.vesopaepos.com", "mail.vesopaepos.com", "amzro.com", "bosheboshe.com", "aishiislam.com",
                 "dreamitinstitute.com", "onzep.uk"]:
        out = cloud(f"dig +short @127.0.0.1 {name} A | head -1; curl -sk -o /dev/null -w '%{{http_code}} %{{redirect_url}}' --resolve {name}:443:34.63.118.67 https://{name}/")
        log(f"    {name:38s} {out.strip().replace(chr(10), '  https→')}")


PHASES = {
    "databases": phase_databases, "backoffice": phase_backoffice, "web": phase_web, "sites": phase_sites,
    "mail": phase_mail, "personal": phase_personal, "customers": phase_customers, "dns": phase_dns, "mailsync": phase_mailsync, "check": phase_check,
}

if __name__ == "__main__":
    wanted = sys.argv[1:] or ["check"]
    if wanted == ["all"]:
        wanted = list(PHASES)
    for w in wanted:
        PHASES[w]()
    (ROOT / "tool" / "migrate_old_box.log").write_text("\n".join(LOG), encoding="utf-8")
