"""Vesopa Go's server half: the back office's /api/go and /api/tap, Go's own
Vesopa Auth client, and go.vesopaepos.com. Run by .github/workflows/go-server.yml
on GitHub's machine, over SSH with VESOPA_SSH_PASSWORD (askpass, set up by the
workflow); or from the owner's PC with the same environment.

    python vesopa_go/tool/go_server.py check     # what a deploy would do; changes nothing
    python vesopa_go/tool/go_server.py staging   # staging.backoffice.vesopaepos.com
    python vesopa_go/tool/go_server.py live      # backoffice.vesopaepos.com and go.vesopaepos.com

The repository is public and so are the run's logs: this prints file names,
counts, sizes and ids only. Never file contents, .env values or anyone's data.

What `staging` and `live` do, in order, stopping at the first thing wrong:

  1. drift   every file under src/ and public/ on the server against this
             checkout. A server file that is an earlier git version of the file
             is replaced. One that is not (edited by hand on the server) is
             merged: three-way, against the git version nearest to it, so the
             server's own edits are kept. A merge that conflicts stops the run
             before anything changes (public/ files that conflict are left as
             the server has them).
  2. modules every package the new code requires must already be installed.
  3. backup  in /home/vesopasoftware/backups/go-<stamp>/ on the server (0700):
             the app's src, public, schema and .env as a tar.gz, and a dump of
             the back-office and Vesopa Auth databases. Nothing is deleted from
             any database, ever; the dumps are there so anything can be undone.
  4. deploy  the changed files (nothing on the server is deleted), then
             schema/schema_tap.sql (CREATE TABLE IF NOT EXISTS only) and
             schema/schema_go_licence.sql (The Vesopa Kitchen's Go licence,
             INSERT IGNORE: added only when the venue has none).
  5. auth    vesopa_auth/schema/schema_028_vesopa_go_client.sql: Go's own client,
             a copy of the till's (adds rows only; nothing if it is there), and
             VESOPA_AUTH_GO_CLIENT_ID in the app's .env.
  6. restart by name, then /health, /api/tap/config (401: wants a phone) and
             /api/go/vesopa/enabled must answer. If not, the files and .env go
             back from the backup and it restarts again.
  7. live only: go.vesopaepos.com, a DNS record and web domain on the Cloud box
             (account vesopasoftware, which has the vesopaepos.com zone),
             proxied to the back office with WebSocket upgrades, and a Let's
             Encrypt certificate.
"""
import base64
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SERVER_DIR = REPO / "vesopa_server"
AUTH_SQL = REPO / "vesopa_auth" / "schema" / "schema_028_vesopa_go_client.sql"
HOST = os.environ.get("VESOPA_SSH_HOST", "root@34.63.118.67")
IP = "34.63.118.67"
USER = "vesopasoftware"
PARTS = ["src", "public"]
GO_DOMAIN = "go.vesopaepos.com"
ZONE = "vesopaepos.com"
H = "export PATH=$PATH:/usr/local/hestia/bin; "
PM2 = f"su - {USER} -c 'PM2_HOME=/home/{USER}/.pm2 pm2 {{}}'"


def target(mode):
    domain = "staging.backoffice.vesopaepos.com" if mode == "staging" else "backoffice.vesopaepos.com"
    return domain, f"/home/{USER}/web/{domain}/private/nodeapp"


def sh(script, *, check=True, data=None):
    """Runs a bash script on the server; returns its stdout as bytes."""
    payload = script.encode() if data is None else data
    cmd = ["ssh", "-o", "BatchMode=no", HOST, "bash -s" if data is None else script]
    r = subprocess.run(cmd, input=payload, capture_output=True)
    if check and r.returncode:
        err = r.stderr.decode(errors="replace").strip().splitlines()[-3:]
        raise SystemExit(f"! on the server (exit {r.returncode}): {' | '.join(err)}")
    return r.stdout


def text(script, **kw):
    return sh(script, **kw).decode(errors="replace").strip()


def note(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- drift

def local_files():
    out = {}
    for part in PARTS:
        for p in (SERVER_DIR / part).rglob("*"):
            rel = p.relative_to(SERVER_DIR).as_posix()
            if (p.is_file() and "node_modules" not in p.parts and p.name != ".DS_Store" and not p.name.endswith(".log")
                    and ".bak" not in p.name and not rel.startswith("public/uploads/")):
                out[rel] = p
    return out


def remote_hashes(app):
    listing = text(f"cd {app} && find {' '.join(PARTS)} -type f -not -name '*.bak-*' -not -name '*.log' "
                   "-not -path '*/node_modules/*' -not -path 'public/uploads/*' -print0 | sort -z | xargs -0 sha1sum")
    out = {}
    for line in listing.splitlines():
        digest, _, path = line.partition("  ")
        if len(digest) == 40 and path:
            out[path.strip()] = digest
    return out


def git(*args, binary=False):
    r = subprocess.run(["git", *args], cwd=REPO, capture_output=True, check=True)
    return r.stdout if binary else r.stdout.decode()


def history(path):
    """Every version of vesopa_server/<path> this checkout's history has had, newest first."""
    commits = git("log", "--format=%H", "--", f"vesopa_server/{path}").split()
    seen, out = set(), []
    for c in commits:
        try:
            blob = git("show", f"{c}:vesopa_server/{path}", binary=True)
        except subprocess.CalledProcessError:
            continue
        h = hashlib.sha1(blob).hexdigest()
        if h not in seen:
            seen.add(h)
            out.append((c[:9], blob))
    return out


def remote_file(app, path):
    return base64.b64decode(sh(f"base64 -w0 {shlex.quote(app + '/' + path)}"))


def diff_size(a, b):
    with tempfile.TemporaryDirectory() as t:
        pa, pb = Path(t, "a"), Path(t, "b")
        pa.write_bytes(a)
        pb.write_bytes(b)
        r = subprocess.run(["git", "diff", "--no-index", "--numstat", str(pa), str(pb)], capture_output=True, text=True)
        nums = r.stdout.split()[:2]
        return sum(int(n) for n in nums if n.isdigit()) if nums else 0


def merge(server, base, ours):
    with tempfile.TemporaryDirectory() as t:
        ps, pb, po = Path(t, "server"), Path(t, "base"), Path(t, "ours")
        ps.write_bytes(server)
        pb.write_bytes(base)
        po.write_bytes(ours)
        r = subprocess.run(["git", "merge-file", "-p", str(ps), str(pb), str(po)], capture_output=True)
        return r.stdout, r.returncode  # returncode: number of conflicts (<0 on error)


def patch_hunks(server, base, ours):
    """base -> ours as a patch, applied to the server's file hunk by hunk with
    fuzz. Returns (content, failed hunk headers)."""
    with tempfile.TemporaryDirectory() as t:
        pb, po, ps = Path(t, "base"), Path(t, "ours"), Path(t, "server")
        pb.write_bytes(base)
        po.write_bytes(ours)
        ps.write_bytes(server)
        diff = subprocess.run(["diff", "-u", str(pb), str(po)], capture_output=True).stdout
        r = subprocess.run(["patch", "--forward", "--fuzz=3", "--no-backup-if-mismatch", "-r", str(Path(t, "rej")), str(ps)],
                           input=diff, capture_output=True)
        failed = re.findall(r"Hunk #\d+ FAILED at \d+", r.stdout.decode(errors="replace"))
        rej = Path(t, "rej").read_bytes() if Path(t, "rej").exists() else b""
        # A failed hunk leaves the server's own version of that spot, as it is
        # today. That is fine unless the hunk is part of Go (tap/go routes).
        essential = bool(re.search(rb"^[+-].*\b(tap|Tap|tapPhones|/api/go|go_)\b", rej, re.M))
        return ps.read_bytes(), failed, essential


def plan(app):
    """What goes up: {path: bytes}, and what stops the run."""
    local, remote = local_files(), remote_hashes(app)
    if not remote:
        raise SystemExit(f"! could not read the server's files in {app}")
    upload, conflicts, kept, merged, replaced, new = {}, [], [], [], [], []
    for path, p in sorted(local.items()):
        mine = p.read_bytes()
        if path not in remote:
            upload[path] = mine
            new.append(path)
            continue
        if hashlib.sha1(mine).hexdigest() == remote[path]:
            continue
        versions = history(path)
        if any(hashlib.sha1(b).hexdigest() == remote[path] for _, b in versions):
            upload[path] = mine
            replaced.append(path)
            continue
        # Edited on the server: merge from the git version nearest to it.
        server = remote_file(app, path)
        if b"\0" in server[:8000] or not versions:
            (kept if path.startswith("public/") else conflicts).append(path)
            continue
        base_rev, base = min(versions, key=lambda v: diff_size(v[1], server))
        out, n = merge(server, base, mine)
        if n == 0:
            upload[path] = out
            merged.append(f"{path} (server's edits kept; base {base_rev})")
        elif path.startswith("public/"):
            kept.append(path)
        else:
            patched, failed, essential = patch_hunks(server, base, mine)
            if not failed or not essential:
                upload[path] = patched
                skipped = f"; skipped, the server keeps its own: {', '.join(failed)}" if failed else ""
                merged.append(f"{path} (server's edits kept, this checkout's changes patched in{skipped}; base {base_rev})")
            else:
                conflicts.append(f"{path} ({n} conflicting places, base {base_rev}; patch: {', '.join(failed)})")
    only_server = sorted(set(remote) - set(local))
    for label, files in (("new", new), ("replaced (an earlier git version on the server)", replaced),
                         ("merged (edited on the server)", merged), ("left as the server has it", kept),
                         ("CONFLICTS", conflicts), ("only on the server (left alone)", only_server)):
        note(f"  {len(files)} {label}")
        for f in files[:40]:
            note(f"    {f}")
        if len(files) > 40:
            note(f"    ... and {len(files) - 40} more")
    return upload, conflicts


def modules_missing(app, upload):
    names = set()
    for path, body in upload.items():
        if path.endswith(".js") and path.startswith("src/"):
            for m in re.findall(rb"require\(\s*['\"]([^'\"./][^'\"]*)['\"]\s*\)", body):
                name = m.decode()
                name = "/".join(name.split("/")[:2]) if name.startswith("@") else name.split("/")[0]
                if not name.startswith("node:"):
                    names.add(name)
    if not names:
        return []
    js = "const m=" + json.dumps(sorted(names)) + ";for(const n of m){try{require.resolve(n)}catch(e){try{require('module').builtinModules.includes(n)||console.log(n)}catch(_){console.log(n)}}}"
    out = text(f"cd {app} && node -e {shlex.quote(js)}", check=False)
    return [l for l in out.splitlines() if l.strip()]


# ---------------------------------------------------------------- probes

def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return r.status, r.read(2000).decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def probes(domain):
    health, _ = fetch(f"https://{domain}/health")
    tap, _ = fetch(f"https://{domain}/api/tap/config")
    go, body = fetch(f"https://{domain}/api/go/vesopa/enabled")
    try:
        enabled = json.loads(body) if go == 200 else {}
    except ValueError:
        enabled = {}
    return health, tap, go, enabled


def show_probes(domain):
    health, tap, go, enabled = probes(domain)
    note(f"  https://{domain}: /health {health}, /api/tap/config {tap}, /api/go/vesopa/enabled {go}"
         + (f" (enabled {enabled.get('enabled')}, client {enabled.get('clientId')})" if enabled else ""))


# ---------------------------------------------------------------- steps

def auth_app():
    return text("ls -d /home/*/web/auth.vesopa.com/private/nodeapp 2>/dev/null | head -1")


def db(app):
    return f"cd {app} && mariadb $(grep -E '^DB_NAME=' .env | cut -d= -f2)"


def backup(app, auth):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    folder = f"/home/{USER}/backups/go-{stamp}"
    dump = "$(command -v mariadb-dump || command -v mysqldump) --single-transaction --quick --routines --triggers --events"
    sh(f"""set -eo pipefail
mkdir -p {folder} && chmod 700 {folder}
cd {app} && tar -czf {folder}/app-files.tgz src public schema .env
{dump} $(grep -E '^DB_NAME=' .env | cut -d= -f2) | gzip > {folder}/backoffice-db.sql.gz
cd {auth} && {dump} $(grep -E '^DB_NAME=' .env | cut -d= -f2) | gzip > {folder}/auth-db.sql.gz
chmod 600 {folder}/*""")
    note(f"  {folder}")
    note(text(f"cd {folder} && ls -la --block-size=K | awk 'NR>1 && $9 !~ /^\\.\\.?$/ {{print \"    \"$9\" \"$5}}'"))
    return folder


def deploy_files(app, upload):
    with tempfile.TemporaryDirectory() as t:
        for path, body in upload.items():
            f = Path(t, path)
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(body)
        tgz = subprocess.run(["tar", "-czf", "-", "-C", t, "."], capture_output=True, check=True).stdout
    sh(f"cd {app} && tar -xzf - --no-same-owner && chown -R {USER}:{USER} src public", data=tgz)
    note(f"  {len(upload)} files up")
    schema = SERVER_DIR / "schema" / "schema_tap.sql"
    sh(f"mkdir -p {app}/schema && cat > {app}/schema/schema_tap.sql && chown {USER}:{USER} {app}/schema/schema_tap.sql",
       data=schema.read_bytes())
    sh(f"{db(app)} < schema/schema_tap.sql")
    note("  schema_tap.sql applied (CREATE TABLE IF NOT EXISTS)")
    # Vesopa Go's licence for the test venue (adds a row only when it has none).
    lic = SERVER_DIR / "schema" / "schema_go_licence.sql"
    sh(f"cat > {app}/schema/schema_go_licence.sql && chown {USER}:{USER} {app}/schema/schema_go_licence.sql", data=lic.read_bytes())
    sh(f"{db(app)} < schema/schema_go_licence.sql")
    note("  schema_go_licence.sql applied (The Vesopa Kitchen's Go licence, added only if missing)")
    # Staff photos (ADD COLUMN IF NOT EXISTS: nothing removed).
    photo = SERVER_DIR / "schema" / "schema_staff_photo.sql"
    sh(f"cat > {app}/schema/schema_staff_photo.sql && chown {USER}:{USER} {app}/schema/schema_staff_photo.sql", data=photo.read_bytes())
    sh(f"{db(app)} < schema/schema_staff_photo.sql")
    note("  schema_staff_photo.sql applied (bo_clarks.photo_url, if missing)")
    # Staff drink slips (2026-10-30): a column and a table, both only if missing.
    staff = SERVER_DIR / "schema" / "schema_staff_items.sql"
    sh(f"cat > {app}/schema/schema_staff_items.sql && chown {USER}:{USER} {app}/schema/schema_staff_items.sql", data=staff.read_bytes())
    sh(f"{db(app)} < schema/schema_staff_items.sql")
    note("  schema_staff_items.sql applied (bo_products.staff_item, epos_staff_drinks, if missing)")


def auth_client(app, auth):
    sh(f"cat > /tmp/schema_028_vesopa_go_client.sql", data=AUTH_SQL.read_bytes())
    out = text(f"{db(auth)} -N < /tmp/schema_028_vesopa_go_client.sql; rm -f /tmp/schema_028_vesopa_go_client.sql")
    m = re.search(r"vesopa-go client_id=([0-9a-f]{16,64})", out)
    if not m:
        raise SystemExit("! Vesopa Auth did not report Go's client (is the till's 'Vesopa EPOS' native app there?)")
    client = m.group(1)
    note(f"  Vesopa Go's Vesopa Auth client: {client}")
    sh(f"""cd {app} && if grep -q '^VESOPA_AUTH_GO_CLIENT_ID=' .env; then
  sed -i 's/^VESOPA_AUTH_GO_CLIENT_ID=.*/VESOPA_AUTH_GO_CLIENT_ID={client}/' .env
else
  printf '\\nVESOPA_AUTH_GO_CLIENT_ID={client}\\n' >> .env
fi""")
    note("  VESOPA_AUTH_GO_CLIENT_ID set in the app's .env")
    return client


def restart_and_check(domain, app, folder):
    sh(PM2.format(f"restart {domain} --update-env") + " >/dev/null")
    for _ in range(18):
        time.sleep(5)
        health, tap, go, enabled = probes(domain)
        if health == 200 and tap == 401 and go == 200:
            note(f"  /health 200, /api/tap/config 401, /api/go/vesopa/enabled 200 (enabled {enabled.get('enabled')}, "
                 f"client {enabled.get('clientId')})")
            return enabled
    note(f"  not right after the restart (/health {health}, /api/tap/config {tap}, /api/go/vesopa/enabled {go}): "
         "putting the backup back")
    sh(f"cd {app} && tar -xzf {folder}/app-files.tgz && chown -R {USER}:{USER} src public schema .env && "
       + PM2.format(f"restart {domain} --update-env") + " >/dev/null", check=False)
    time.sleep(10)
    health, *_ = probes(domain)
    raise SystemExit(f"! rolled back ({'healthy' if health == 200 else 'NOT healthy: look at pm2 logs'}). "
                     "The tables schema_tap.sql made and Go's Vesopa Auth client are left; unused without the code.")


def go_domain(port):
    note(f"== {GO_DOMAIN}")
    rec = text(H + f"v-list-dns-records {USER} {ZONE} plain | awk '$2==\"go\" {{print $3\" \"$4}}'")
    if rec:
        note(f"  DNS: go {rec}")
    else:
        sh(H + f"v-add-dns-record {USER} {ZONE} go A {IP}")
        note(f"  DNS: go A {IP} added")
    if GO_DOMAIN not in text(H + f"v-list-web-domains {USER} plain | cut -f1").split():
        sh(H + f"v-add-web-domain {USER} {GO_DOMAIN} {IP} no")
        note("  web domain: added")
    else:
        note("  web domain: there")
    conf = f"/home/{USER}/conf/web/{GO_DOMAIN}/nodeapp.conf"
    sh(f"""cat > {conf} <<'EOF'
location / {{
	proxy_pass http://127.0.0.1:{port};
	proxy_http_version 1.1;
	proxy_set_header Upgrade $http_upgrade;
	proxy_set_header Connection $connection_upgrade;
	proxy_set_header Host $host;
	proxy_set_header X-Real-IP $remote_addr;
	proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
	proxy_set_header X-Forwarded-Proto $scheme;
	proxy_cache_bypass $http_upgrade;
	proxy_read_timeout 300s;
}}
EOF
chown {USER}:{USER} {conf}""")
    note("  proxy: " + (text(H + f"v-change-web-domain-proxy-tpl {USER} {GO_DOMAIN} NodeJS '' yes 2>&1 | tail -1") or f"NodeJS, to port {port}"))
    ssl = lambda: '"yes"' in text(H + f"v-list-web-domain {USER} {GO_DOMAIN} json | grep '\"SSL\"'", check=False)  # noqa: E731
    if ssl():
        note("  certificate: there")
    else:
        for _ in range(8):
            res = text(H + f"v-add-letsencrypt-domain {USER} {GO_DOMAIN} '' no 2>&1 | tail -1", check=False)
            if ssl():
                note("  certificate: issued")
                break
            note(f"  certificate: not yet ({res[-100:]}); waiting for DNS")
            time.sleep(30)
    sh("nginx -t 2>/dev/null && systemctl reload nginx", check=False)
    for _ in range(6):
        st, _ = fetch(f"https://{GO_DOMAIN}/health")
        if st == 200:
            break
        time.sleep(10)
    note(f"  https://{GO_DOMAIN}/health {st}")
    return st == 200


def port_of(app):
    return text(f"grep -E '^PORT=' {app}/.env | cut -d= -f2 | tr -d '\"\\r '") or "20005"


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in ("check", "staging", "live"):
        raise SystemExit(__doc__)
    note(f"SSH: {'ok' if text('echo ok') == 'ok' else 'no'}")
    for m in (("staging", "live") if mode == "check" else (mode,)):
        domain, app = target(m)
        note(f"\n== {domain}")
        if not text(f"test -d {app} && echo yes", check=False):
            note("  not on the box")
            continue
        show_probes(domain)
        upload, conflicts = plan(app)
        missing = modules_missing(app, upload)
        note(f"  packages the new code needs that are not installed: {', '.join(missing) or 'none'}")
        if mode == "check":
            continue
        if conflicts:
            raise SystemExit("! stopped before changing anything: the files above conflict with edits made on the server.")
        if missing:
            raise SystemExit("! stopped before changing anything: install those packages first.")
        auth = auth_app()
        if not auth:
            raise SystemExit("! no Vesopa Auth app on the box")
        note("== backup")
        folder = backup(app, auth)
        note("== deploy")
        deploy_files(app, upload)
        note("== Vesopa Auth")
        auth_client(app, auth)
        note("== restart")
        restart_and_check(domain, app, folder)
        if m == "live":
            go_domain(port_of(app))
            show_probes(GO_DOMAIN)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as f:
                f.write(f"### {domain}\n\nBackup on the server: `{folder}`\n\n")
    if mode == "check":
        note(f"\n== {GO_DOMAIN}")
        show_probes(GO_DOMAIN)


if __name__ == "__main__":
    main()
