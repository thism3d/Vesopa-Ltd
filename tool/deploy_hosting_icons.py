"""Back up and deploy the cloud.vesopa.com missing-icon fix.

    python tool/deploy_hosting_icons.py            # back up, deploy, restart, verify
    python tool/deploy_hosting_icons.py --check    # only show what it would do

Sends vesopa_hosting/public/assets/css/app.css to the live hosting panel on the
Cloud box (34.63.118.67). On Safari (iPad) every icon centred in a grid button
(the Files toolbar's view, hidden-files and refresh buttons, each row's menu)
showed as a dot, because the CSS reset gave svg `max-width: 100%`.

Steps: a tar.gz backup of the live app in /home/vesopasoftware/backups, upload
of the one file, chown, `pm2 restart cloud.vesopa.com` as vesopasoftware (the
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
FILES = ["vesopa_hosting/public/assets/css/app.css"]
APP = f"/home/{base.USER}/web/{DOMAIN}/private/nodeapp"
NEEDLE = "img, video { max-width: 100%"


def main():
    check_only = "--check" in sys.argv
    client = base.vesopa_ssh.connect()
    try:
        status, _ = base.sh(client, f"test -d {APP}", quiet=True)
        if status != 0:
            print(f"! {APP} does not exist on the server")
            sys.exit(1)
        print(f"== {DOMAIN}: " + ", ".join(FILES))
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
            for f in FILES:
                dest = posixpath.join(APP, f[len(FOLDER) + 1:])
                sftp.put(str(base.ROOT / f), dest)
            print(f"   uploaded {len(FILES)} file(s)")
        finally:
            sftp.close()

        base.sh(client, f"chown -R {base.USER}:{base.USER} {APP}/public", quiet=True)
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
    except Exception as e:  # noqa: BLE001
        css_url, code, good = f"https://{DOMAIN}/assets/css/app.css", str(e), False
    print(f"   {'ok ' if good else 'BAD'} {css_url} -> {code}")
    print("\nOK  cloud.vesopa.com" if good else "\nFAIL cloud.vesopa.com")
    sys.exit(0 if good else 1)


if __name__ == "__main__":
    main()
