"""Back up and deploy the cloud.vesopa.com icon fixes.

    python tool/deploy_hosting_icons.py            # back up, deploy, restart, verify
    python tool/deploy_hosting_icons.py --check    # only show what it would do

Sends every vesopa_hosting file changed since dd55c0b to the live hosting panel
on the Cloud box (34.63.118.67): the CSS fix below, and the browser tab icon,
now the same black tile as auth.vesopa.com instead of a lime one. On Safari (iPad) every icon centred in a grid button
(the Files toolbar's view, hidden-files and refresh buttons, each row's menu)
showed as a dot, because the CSS reset gave svg `max-width: 100%`.

Steps: a tar.gz backup of the live app in /home/vesopasoftware/backups, upload
of the changed files (never .env), chown, `pm2 restart cloud.vesopa.com` as vesopasoftware (the
restart also changes the ?v= stamp so browsers fetch the new CSS), then a check
that the live app.css carries the fix.

Credentials and SSH come from tool/deploy_websites_cookie_notice.py, which reads
VESOPA_SSH_PASSWORD from .env.claude-tools or .env.claude.

To roll back:  tar -xzf /home/vesopasoftware/backups/<file>.tgz -C <app dir>
then `pm2 restart cloud.vesopa.com` as vesopasoftware.
"""
import posixpath
import re
import sys
import time

import deploy_websites_cookie_notice as base

DOMAIN = "cloud.vesopa.com"
FOLDER = "vesopa_hosting"
BASE_COMMIT = "dd55c0b"  # main before the icon fixes
APP = f"/home/{base.USER}/web/{DOMAIN}/private/nodeapp"
NEEDLE = "img, video { max-width: 100%"
SVG_NEEDLE = 'fill="#A5C715"'


def changed_files():
    base.BASE_COMMIT = BASE_COMMIT
    return base.changed_files(FOLDER)


def main():
    check_only = "--check" in sys.argv
    files = changed_files()
    client = base.vesopa_ssh.connect()
    try:
        status, _ = base.sh(client, f"test -d {APP}", quiet=True)
        if status != 0:
            print(f"! {APP} does not exist on the server")
            sys.exit(1)
        print(f"== {DOMAIN}: {len(files)} files")
        for f in files:
            print("   " + f)
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

        base.sh(client, f"chown -R {base.USER}:{base.USER} {APP}/public {APP}/views", quiet=True)
        status, _ = base.sh(client, base.PM2.format(f"restart {DOMAIN}") + " >/dev/null && echo restarted")
        if status != 0:
            print(f"! pm2 restart failed; roll back with: tar -xzf {backup} -C {APP}")
            sys.exit(1)
        time.sleep(4)
    finally:
        client.close()

    try:
        code, page = base.fetch(f"https://{DOMAIN}/")
        m = re.search(r'/assets/css/app\.css\?v=[\w]+', page)
        css_url = f"https://{DOMAIN}" + (m.group(0) if m else "/assets/css/app.css")
        code, css = base.fetch(css_url)
        good = code == 200 and NEEDLE in css
        print(f"   {'ok ' if good else 'BAD'} {css_url} -> {code}")
        icon_ok = 'favicon.svg' in page
        if icon_ok:
            _, svg = base.fetch(f"https://{DOMAIN}/favicon.svg")
            icon_ok = SVG_NEEDLE in svg
        print(f"   {'ok ' if icon_ok else 'BAD'} https://{DOMAIN}/favicon.svg")
        good = good and icon_ok
    except Exception as e:  # noqa: BLE001
        good = False
        print(f"   BAD check failed: {e}")
    print("\nOK  cloud.vesopa.com" if good else "\nFAIL cloud.vesopa.com")
    sys.exit(0 if good else 1)


if __name__ == "__main__":
    main()
