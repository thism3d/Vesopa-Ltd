"""Deploy "Show another website here" to cloud.vesopa.com and its node (2026-10-19).

    python tool/deploy_cloud_reverse_proxy.py            # back up, install, deploy, restart, verify
    python tool/deploy_cloud_reverse_proxy.py --check    # only show what it would do

1. The node: v-change-web-domain-reverse-proxy into /usr/local/hestia/bin and
   the ReverseProxy nginx templates into Hestia's web templates (root, 0755 /
   0644), from vesopa_hosting/hestia-installer-script.
2. The panel: every vesopa_hosting app file changed since 82d5e9b1, after
   checking each live file is still that version (never overwrites blind),
   with a tar.gz backup first; the domains.reverse_proxy column; pm2 restart.

To roll back the panel:  tar -xzf /home/vesopasoftware/backups/<file>.tgz -C <app dir>
then `pm2 restart cloud.vesopa.com` as vesopasoftware.
"""
import hashlib
import posixpath
import subprocess
import sys
import time

import deploy_websites_cookie_notice as base

DOMAIN = "cloud.vesopa.com"
FOLDER = "vesopa_hosting"
BASE_COMMIT = "82d5e9b1"  # main before the reverse proxy
HESTIA_SRC = "vesopa_hosting/hestia-installer-script"
APP = f"/home/{base.USER}/web/{DOMAIN}/private/nodeapp"


def at_base(path):
    """sha256 of the file at BASE_COMMIT with CRs removed, or "" if it did not exist."""
    r = subprocess.run(["git", "show", f"{BASE_COMMIT}:{path}"], cwd=base.ROOT, capture_output=True)
    # Windows checkouts upload CRLF, sometimes mixed with LF, so line endings
    # never count as a difference.
    return hashlib.sha256(r.stdout.replace(b"\r", b"")).hexdigest() if r.returncode == 0 else ""


def main():
    check_only = "--check" in sys.argv
    base.BASE_COMMIT = BASE_COMMIT
    files = [f for f in base.changed_files(FOLDER) if not f.startswith(HESTIA_SRC + '/')]
    client = base.vesopa_ssh.connect()
    try:
        status, _ = base.sh(client, f"test -d {APP}", quiet=True)
        if status != 0:
            print(f"! {APP} does not exist on the server")
            sys.exit(1)
        print(f"== {DOMAIN}: {len(files)} files")
        drift = []
        for f in files:
            live = posixpath.join(APP, f[len(FOLDER) + 1:])
            _, out = base.sh(client, f"test -f {live} && tr -d '\\r' < {live} | sha256sum | cut -d' ' -f1", quiet=True)
            want = at_base(f)
            same = out.strip() == want  # a new file is absent on both sides
            print(f"   {'ok   ' if same else 'DRIFT'} {f}")
            if not same:
                drift.append(f)
        if drift:
            print("! live files differ from the version this deploy replaces; nothing was changed")
            sys.exit(1)
        if check_only:
            return

        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = f"{base.BACKUPS}/{DOMAIN}-{stamp}.tgz"
        status, _ = base.sh(client, (
            f"mkdir -p {base.BACKUPS} && tar -czf {backup} -C {APP} "
            "--exclude=./node_modules --exclude=./uploads --exclude=./logs --exclude=./backup . "
            f"&& ls -lh {backup} | awk '{{print $5}}'"
        ))
        if status != 0:
            print("! backup failed; nothing was changed")
            sys.exit(1)
        print(f"   backup: {backup}")

        # The node: our Hestia command and the ReverseProxy templates.
        sftp = client.open_sftp()
        try:
            for local, remote, mode in [
                (f"{HESTIA_SRC}/bin/v-change-web-domain-reverse-proxy", "/usr/local/hestia/bin/v-change-web-domain-reverse-proxy", "0755"),
                (f"{HESTIA_SRC}/templates/nginx/ReverseProxy.tpl", "/usr/local/hestia/data/templates/web/nginx/ReverseProxy.tpl", "0644"),
                (f"{HESTIA_SRC}/templates/nginx/ReverseProxy.stpl", "/usr/local/hestia/data/templates/web/nginx/ReverseProxy.stpl", "0644"),
            ]:
                tmp = "/tmp/" + posixpath.basename(remote)
                data = (base.ROOT / local).read_bytes().replace(b"\r\n", b"\n")
                with sftp.open(tmp, "wb") as fh:
                    fh.write(data)
                status, _ = base.sh(client, f"install -o root -g root -m {mode} {tmp} {remote} && rm -f {tmp}", quiet=True)
                print(f"   {'ok ' if status == 0 else 'BAD'} {remote}")
                if status != 0:
                    sys.exit(1)
        finally:
            sftp.close()

        # The panel's column for what a domain shows.
        status, out = base.sh(client, (
            f"cd {APP} && set -a && . ./.env 2>/dev/null; set +a; "
            "mariadb -u$DB_USER -p\"$DB_PASSWORD\" $DB_NAME -e "
            "\"ALTER TABLE domains ADD COLUMN IF NOT EXISTS reverse_proxy VARCHAR(255) CHARACTER SET utf8mb4 "
            "COLLATE utf8mb4_general_ci NOT NULL DEFAULT ''\" && echo column-ok"
        ), quiet=True)
        print(f"   {'ok ' if 'column-ok' in out else 'BAD'} domains.reverse_proxy")
        if "column-ok" not in out:
            sys.exit(1)

        sftp = client.open_sftp()
        try:
            for f in files:
                dest = posixpath.join(APP, f[len(FOLDER) + 1:])
                base.vesopa_ssh._mkdirs(sftp, posixpath.dirname(dest))
                sftp.put(str(base.ROOT / f), dest)
            print(f"   uploaded {len(files)} file(s)")
        finally:
            sftp.close()

        base.sh(client, f"chown -R {base.USER}:{base.USER} {APP}/src {APP}/views", quiet=True)
        status, _ = base.sh(client, base.PM2.format(f"restart {DOMAIN}") + " >/dev/null && echo restarted")
        if status != 0:
            print(f"! pm2 restart failed; roll back with: tar -xzf {backup} -C {APP}")
            sys.exit(1)
        time.sleep(5)
        _, joined = base.sh(client, (
            f"cd {APP} && node -e \"console.log(typeof require('./src/integrations/hestia').setReverseProxy)\""
        ), quiet=True)
        phone_ok = joined.strip() == "function"
    finally:
        client.close()

    try:
        code, page = base.fetch(f"https://{DOMAIN}/")
        site_ok = code == 200
    except Exception as e:  # noqa: BLE001
        site_ok = False
        print(f"   BAD homepage: {e}")
    print(f"   {'ok ' if site_ok else 'BAD'} https://{DOMAIN}/")
    print(f"   {'ok ' if phone_ok else 'BAD'} the panel has the reverse proxy")
    good = site_ok and phone_ok
    print("\nOK  cloud.vesopa.com" if good else f"\nFAIL cloud.vesopa.com (roll back: tar -xzf {backup} -C {APP})")
    sys.exit(0 if good else 1)


if __name__ == "__main__":
    main()
