"""Deploy vesopa_web/ (vesopaepos.com) changes since the last deployed commit.

    python tool/deploy_vesopaepos_site.py --check     # list the files, compare with live, change nothing
    python tool/deploy_vesopaepos_site.py             # back up, upload, restart, verify

2026-10-24: the website additions (accreditation band, payments and cashback,
online ordering, rewards and apps, hardware teaser, /hardware shop, real
screens in the carousel, socials). Same routine as
tool/deploy_websites_cookie_notice.py (which last shipped vesopa_web at
7866d7d), plus one guard: every file that already exists on the server must
still match its copy at BASE_COMMIT, so a change someone made directly on the
server is never overwritten unseen. A mismatch stops the deploy before
anything is uploaded.

Roll back:  tar -xzf /home/vesopasoftware/backups/vesopaepos.com-<stamp>.tgz -C <app>
then `pm2 restart vesopaepos.com` as vesopasoftware.
"""
import hashlib
import posixpath
import subprocess
import sys
import time

import deploy_websites_cookie_notice as base  # noqa: E402  (settings + ssh helpers)

ROOT = base.ROOT
USER = base.USER
DOMAIN = "vesopaepos.com"
FOLDER = "vesopa_web"
BASE_COMMIT = sys.argv[sys.argv.index("--base") + 1] if "--base" in sys.argv else "7866d7df"
APP = f"/home/{USER}/web/{DOMAIN}/private/nodeapp"


def files_to_send():
    out = subprocess.run(["git", "diff", "--name-only", "--diff-filter=AM", f"{BASE_COMMIT}..HEAD", "--", FOLDER],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    return [f for f in out if not posixpath.basename(f).startswith(".env")
            and "/node_modules/" not in f and not f.startswith(f"{FOLDER}/design/")]


def git_blob(path):
    r = subprocess.run(["git", "show", f"{BASE_COMMIT}:{path}"], cwd=ROOT, capture_output=True)
    return r.stdout if r.returncode == 0 else None


def main():
    check_only = "--check" in sys.argv
    files = files_to_send()
    print(f"== {DOMAIN}: {len(files)} files since {BASE_COMMIT}")
    client = base.vesopa_ssh.connect()
    try:
        sftp = client.open_sftp()
        drift = []
        for f in files:
            old = git_blob(f)
            if old is None:
                continue  # new file
            try:
                with sftp.file(posixpath.join(APP, f[len(FOLDER) + 1:]), "rb") as rf:
                    live = rf.read()
            except IOError:
                continue
            norm = lambda b: b.replace(b"\r\n", b"\n")  # noqa: E731
            if hashlib.sha256(norm(live)).digest() != hashlib.sha256(norm(old)).digest():
                drift.append(f)
        sftp.close()
        for f in files:
            print(("   ! CHANGED ON SERVER  " if f in drift else "   ") + f)
        if drift:
            print(f"\n! {len(drift)} file(s) differ on the server from {BASE_COMMIT}. Nothing was uploaded.")
            sys.exit(2)
        if check_only:
            print("\ncheck only: live files match; nothing changed.")
            return

        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = f"{base.BACKUPS}/{DOMAIN}-{stamp}.tgz"
        status, _ = base.sh(client, f"mkdir -p {base.BACKUPS} && tar -czf {backup} -C {APP} --exclude=./node_modules "
                                    f"--exclude=./uploads --exclude=./logs --exclude=./backup . && ls -lh {backup} | awk '{{print $5}}'")
        if status != 0:
            sys.exit("! backup failed; nothing changed")
        print(f"   backup: {backup}")

        sftp = client.open_sftp()
        for f in files:
            dest = posixpath.join(APP, f[len(FOLDER) + 1:])
            base.vesopa_ssh._mkdirs(sftp, posixpath.dirname(dest))
            sftp.put(str(ROOT / f), dest)
        sftp.close()
        print(f"   uploaded {len(files)} files")
        base.sh(client, f"chown -R {USER}:{USER} {APP}", quiet=True)
        status, _ = base.sh(client, base.PM2.format(f"restart {DOMAIN}") + " >/dev/null && echo restarted")
        if status != 0:
            sys.exit(f"! pm2 restart failed: roll back with tar -xzf {backup} -C {APP}")
    finally:
        client.close()

    time.sleep(5)
    ok = True
    for path, needle in [("/", "v2-accredit"), ("/", "menu.pontardawerfc.com"), ("/hardware", "data-hw-shop"),
                         ("/library/v2.css", ".v2-sec"), ("/assets/v2/till-1566.jpg", ""), ("/sitemap.xml", "/hardware")]:
        url = f"https://{DOMAIN}{path}"
        try:
            code, body = base.fetch(url)
            good = code == 200 and (needle in body)
        except Exception as e:  # noqa: BLE001
            code, good = str(e), False
        print(f"   {'ok ' if good else 'BAD'} {url} -> {code}")
        ok &= good
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT / "tool"))
    main()
