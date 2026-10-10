"""Back up and deploy the cloud.vesopa.com checkout fixes (2026-10-10).

    python tool/deploy_hosting_checkout.py            # back up, deploy, restart, verify
    python tool/deploy_hosting_checkout.py --check    # only show what it would do

Sends every vesopa_hosting file changed since 94c2970: the phone field as a
country-code picker plus the number (checkout, sign-up, account settings), and
a registration that retries on ns1/ns2.onzep.uk when the .com registry refuses
ns1/ns2.vesopa.com.

Before anything is written it checks that each live file is still the version
at 94c2970, so a file changed on the server, or by a newer deploy, is never
overwritten blind. Then: a tar.gz backup of the live app, upload (never .env),
chown, `pm2 restart cloud.vesopa.com`, and checks that the homepage answers and
the live code joins a phone number the new way.

To roll back:  tar -xzf /home/vesopasoftware/backups/<file>.tgz -C <app dir>
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
BASE_COMMIT = "94c2970"  # main before the checkout fixes
APP = f"/home/{base.USER}/web/{DOMAIN}/private/nodeapp"


def at_base(path):
    r = subprocess.run(["git", "show", f"{BASE_COMMIT}:{path}"], cwd=base.ROOT, capture_output=True)
    if r.returncode != 0:
        return set()
    # A Windows checkout may have uploaded it with CRLF endings; both count.
    return {hashlib.sha256(r.stdout).hexdigest(),
            hashlib.sha256(r.stdout.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")).hexdigest()}


def main():
    check_only = "--check" in sys.argv
    base.BASE_COMMIT = BASE_COMMIT
    files = base.changed_files(FOLDER)
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
            _, out = base.sh(client, f"sha256sum {live} 2>/dev/null | cut -d' ' -f1", quiet=True)
            want = at_base(f)
            same = out.strip() in want
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
            f"cd {APP} && node -e \"console.log(require('./src/countries').joinPhone('BD','01977978353'))\""
        ), quiet=True)
        phone_ok = joined.strip() == "+8801977978353"
    finally:
        client.close()

    try:
        code, page = base.fetch(f"https://{DOMAIN}/")
        site_ok = code == 200
    except Exception as e:  # noqa: BLE001
        site_ok = False
        print(f"   BAD homepage: {e}")
    print(f"   {'ok ' if site_ok else 'BAD'} https://{DOMAIN}/")
    print(f"   {'ok ' if phone_ok else 'BAD'} phone joins as +8801977978353")
    good = site_ok and phone_ok
    print("\nOK  cloud.vesopa.com" if good else f"\nFAIL cloud.vesopa.com (roll back: tar -xzf {backup} -C {APP})")
    sys.exit(0 if good else 1)


if __name__ == "__main__":
    main()
