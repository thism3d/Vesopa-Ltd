"""Put Vesopa Tap's server half live, so Tap and Vesopa EPOS Lite can take card
payments, refunds to the card and emailed receipts (src/tap.js, /api/tap/*).

    python tool/deploy_tap.py --check              # live: what would change; changes nothing
    python tool/deploy_tap.py --check --staging    # the same for staging
    python tool/deploy_tap.py --staging            # deploy to staging.backoffice.vesopaepos.com
    python tool/deploy_tap.py --live               # deploy to backoffice.vesopaepos.com

Run from the repository root on the owner's PC (cloud sessions cannot reach
port 22), as tool/deploy_memberships.py is. Staging first, then live.

Why not the "Back office - patch" workflow: it replaces only files the server
already has in a known earlier version, and Tap needs a new file (src/tap.js)
and two new tables (schema/schema_tap.sql). Why not deploy_memberships.py
--backoffice alone: it never applies schema_tap.sql, and has no dry run.

What it does, the way deploy_memberships.py --backoffice does it, plus a
backup and a check:
  1. --check: every file under src/ and public/ on the server against this
     checkout, listed as new, changed and only-on-the-server. Read only.
  2. a tar.gz of the server's src, public and schema in
     /home/vesopasoftware/backups/<domain>-tap-<stamp>.tgz
  3. uploads src, public, schema/schema_tap.sql and the Wallet looks (nothing
     on the server is deleted), applies schema_tap.sql (CREATE TABLE IF NOT
     EXISTS only: re-runnable, touches no venue's data), restarts by name
  4. checks /health answers and /api/tap/config now exists (401: it wants a
     signed-in phone). If either fails, the backup goes back and it restarts.

Everything under vesopa_server/src on this checkout goes up, not only Tap's
files: the server runs one version of the code. --check says what that is.
No new npm packages: Tap uses what the server already has.
"""
import hashlib
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import deploy_memberships as dm  # noqa: E402  (loads .env.claude; ssh helpers)

ROOT = dm.ROOT
USER = dm.USER
SERVER = ROOT / "vesopa_server"
PARTS = ["src", "public"]
SCHEMA = "schema_tap.sql"


def target():
    staging = "--staging" in sys.argv
    domain = "staging.backoffice.vesopaepos.com" if staging else "backoffice.vesopaepos.com"
    return domain, f"/home/{USER}/web/{domain}/private/nodeapp"


def local_hashes():
    out = {}
    for part in PARTS:
        for p in (SERVER / part).rglob("*"):
            if p.is_file() and "node_modules" not in p.parts and p.name != ".DS_Store" and not p.name.endswith(".log"):
                out[p.relative_to(SERVER).as_posix()] = hashlib.sha1(p.read_bytes()).hexdigest()
    return out


def remote_hashes(app):
    listing = dm.ssh("run", f"cd {app} && find {' '.join(PARTS)} -type f -not -name '*.bak-*' -not -name '*.log' "
                            f"-not -path '*/node_modules/*' -print0 | sort -z | xargs -0 sha1sum", check=False)
    out = {}
    for line in listing.splitlines():
        digest, _, path = line.partition("  ")
        if len(digest) == 40 and path:
            out[path.strip()] = digest
    return out


def check(domain, app):
    print(f"== {domain}: what a deploy would change")
    local, remote = local_hashes(), remote_hashes(app)
    if not remote:
        raise SystemExit("Could not read the server's files (sign-in, or the app folder).")
    new = sorted(set(local) - set(remote))
    changed = sorted(f for f in set(local) & set(remote) if local[f] != remote[f])
    only_server = sorted(f for f in set(remote) - set(local) if not f.startswith("public/uploads/"))
    for label, files in (("new", new), ("changed", changed), ("only on the server (left alone)", only_server)):
        print(f"\n{len(files)} {label}")
        for f in files[:60]:
            print(f"  {f}")
        if len(files) > 60:
            print(f"  ... and {len(files) - 60} more")
    print(f"\nTap on the server now: {probe(domain)}")
    return new, changed


def probe(domain):
    """What /api/tap/config answers: 404 before Tap, 401 after (it wants a phone)."""
    try:
        urllib.request.urlopen(f"https://{domain}/api/tap/config", timeout=20)
        return "200"
    except urllib.error.HTTPError as e:
        return {404: "404, not there", 401: "401, there (wants a signed-in phone)"}.get(e.code, str(e.code))
    except Exception as e:  # noqa: BLE001
        return f"no answer ({e})"


def healthy(domain):
    try:
        return urllib.request.urlopen(f"https://{domain}/health", timeout=20).status == 200
    except Exception:  # noqa: BLE001
        return False


def deploy(domain, app):
    new, changed = check(domain, app)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"/home/{USER}/backups/{domain}-tap-{stamp}.tgz"
    print(f"\n▶ backup: {backup}")
    dm.ssh("run", f"mkdir -p /home/{USER}/backups && cd {app} && tar -czf {backup} src public schema && echo ok")

    print("▶ upload")
    stage = pathlib.Path(tempfile.mkdtemp(prefix="tap-"))
    try:
        for part in PARTS:
            dm.stage_dir(SERVER / part, stage / part)
        (stage / "schema").mkdir()
        shutil.copy(SERVER / "schema" / SCHEMA, stage / "schema" / SCHEMA)
        dm.stage_dir(SERVER / "assets" / "wallet" / "looks", stage / "looks")
        for part in [*PARTS, "schema"]:
            dm.ssh("put", str(stage / part), f"{app}/{part}")
        dm.ssh("run", f"mkdir -p {app}/assets/wallet")
        dm.ssh("put", str(stage / "looks"), f"{app}/assets/wallet/looks")
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    print("▶ schema and restart")
    dm.ssh("run",
           f"cd {app} && chown -R {USER}:{USER} src public schema assets/wallet/looks && "
           f"mariadb $(grep -E '^DB_NAME=' .env | cut -d= -f2) < schema/{SCHEMA} && echo '  {SCHEMA} ok' && "
           + dm.PM2.format(f"restart {domain} --update-env") + " | tail -2")

    print("▶ check")
    for _ in range(12):
        time.sleep(5)
        if healthy(domain) and probe(domain).startswith("401"):
            print(f"  /health ok, /api/tap/config there. Tap is live on {domain}.")
            return
    print("  The server did not come back with Tap: restoring the backup.")
    dm.ssh("run", f"cd {app} && tar -xzf {backup} && chown -R {USER}:{USER} src public schema && "
                  + dm.PM2.format(f"restart {domain} --update-env") + " | tail -2", check=False)
    time.sleep(10)
    raise SystemExit(f"Rolled back ({'healthy' if healthy(domain) else 'NOT healthy, look at pm2 logs'}). "
                     f"The tables schema_tap.sql made are left; they are unused without src/tap.js.")


def main():
    domain, app = target()
    if "--check" in sys.argv:
        check(domain, app)
    elif "--staging" in sys.argv or "--live" in sys.argv:
        deploy(domain, app)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
