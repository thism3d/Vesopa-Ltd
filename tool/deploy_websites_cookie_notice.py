"""Back up and deploy the shared cookie notice and the vesopasoftware.com refresh.

    python tool/deploy_websites_cookie_notice.py            # back up, deploy, restart, verify
    python tool/deploy_websites_cookie_notice.py --check    # only show what it would do

Ships commit 7866d7d ("One cookie notice for every Vesopa site, and
vesopasoftware.com with all five apps") and anything after it that touches the
same files, to five live sites on the Cloud box (34.63.118.67):

    vesopaepos.com        vesopa_web/
    vesopasoftware.com    vesopasoftware/
    auth.vesopa.com       vesopa_auth/
    cloud.vesopa.com      vesopa_hosting/
    gift.vesopaepos.com   vesopa_gift/

For each site, in order, stopping that site at the first failure:
  1. a tar.gz of the live app (no node_modules, uploads or logs) in
     /home/vesopasoftware/backups/<domain>-<stamp>.tgz,
  2. the changed files only — the list comes from git, so nothing else on the
     server is touched, and .env is never sent,
  3. chown to vesopasoftware and `pm2 restart <domain>` as that user (never
     `restart all`, never --update-env: the pm2 daemon carries auth's PORT),
  4. a check that the page answers and serves /vesopa-cookies.js.

Credentials: VESOPA_SSH_PASSWORD from .env.claude-tools, exactly like
tool/auth_ssh.py, or else from .env.claude (this checkout, or the main checkout
when run from a worktree). Only the host is overridden.

To roll a site back:  tar -xzf /home/vesopasoftware/backups/<file>.tgz -C <app dir>
then `pm2 restart <domain>` as vesopasoftware.
"""
import pathlib
import posixpath
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".claude" / "skills" / "vesopa-ops" / "scripts"))

import vesopa_ssh  # noqa: E402

HOST = "root@34.63.118.67"
USER = "vesopasoftware"
BASE_COMMIT = "7c67c81"  # main before this work
BACKUPS = f"/home/{USER}/backups"
PM2 = f"su - {USER} -c 'PM2_HOME=/home/{USER}/.pm2 pm2 {{}}'"

SITES = [
    # (repo folder, domain)
    ("vesopasoftware", "vesopasoftware.com"),
    ("vesopa_web", "vesopaepos.com"),
    ("vesopa_auth", "auth.vesopa.com"),
    ("vesopa_hosting", "cloud.vesopa.com"),
    ("vesopa_gift", "gift.vesopaepos.com"),
]

_settings = vesopa_ssh.settings


def _env_claude():
    """VESOPA_SSH_PASSWORD from a gitignored .env.claude, when .env.claude-tools
    is not there. Looks in this checkout and, from a git worktree, in the main
    checkout it belongs to."""
    roots = [ROOT]
    try:
        common = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT,
                                capture_output=True, text=True, check=True).stdout.strip()
        roots.append((ROOT / common).resolve().parent)
    except Exception:  # noqa: BLE001
        pass
    for root in roots:
        f = pathlib.Path(root) / ".env.claude"
        if not f.is_file():
            continue
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key.strip() == "VESOPA_SSH_PASSWORD":
                return value.strip().strip("'\"")
    return None


def settings():
    try:
        values = _settings()
    except SystemExit:
        values = {}
    if not values.get("VESOPA_SSH_PASSWORD"):
        pw = _env_claude()
        if pw:
            values["VESOPA_SSH_PASSWORD"] = pw
    values["VESOPA_SSH_HOST"] = HOST
    return values


vesopa_ssh.settings = settings


def changed_files(folder):
    out = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=AM", f"{BASE_COMMIT}..HEAD", "--", folder],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.split()
    keep = []
    for f in out:
        name = posixpath.basename(f)
        if name.startswith(".env") or "/node_modules/" in f:
            continue
        keep.append(f)
    return keep


def sh(client, command, quiet=False):
    stdin, stdout, stderr = client.exec_command(command, timeout=900)
    stdin.close()
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    status = stdout.channel.recv_exit_status()
    if not quiet and out.strip():
        print("    " + out.strip().replace("\n", "\n    "))
    if err.strip() and status != 0:
        print("    ! " + err.strip().replace("\n", "\n    ! "))
    return status, out


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 vesopa-deploy-check"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, r.read().decode("utf-8", "replace")


def deploy(client, folder, domain, check_only):
    app = f"/home/{USER}/web/{domain}/private/nodeapp"
    files = changed_files(folder)
    print(f"\n== {domain}  ({len(files)} files from {folder}/)")
    if not files:
        print("   nothing to send")
        return True
    status, _ = sh(client, f"test -d {app}", quiet=True)
    if status != 0:
        print(f"   ! {app} does not exist on the server; skipped")
        return False
    if check_only:
        for f in files:
            print("   " + f)
        return True

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"{BACKUPS}/{domain}-{stamp}.tgz"
    status, _ = sh(client, (
        f"mkdir -p {BACKUPS} && tar -czf {backup} -C {app} "
        "--exclude=./node_modules --exclude=./uploads --exclude=./logs --exclude=./backup "
        "--exclude=./site/assets/video_frames . && ls -lh " + backup + " | awk '{print $5}'"
    ))
    if status != 0:
        print("   ! backup failed; this site was NOT changed")
        return False
    print(f"   backup: {backup}")

    sftp = client.open_sftp()
    try:
        for f in files:
            rel = f[len(folder) + 1:]
            dest = posixpath.join(app, rel)
            vesopa_ssh._mkdirs(sftp, posixpath.dirname(dest))
            sftp.put(str(ROOT / f), dest)
        print(f"   uploaded {len(files)} files")
    finally:
        sftp.close()

    sh(client, f"chown -R {USER}:{USER} {app}", quiet=True)
    # vesopaepos.com also has a public_html that nginx may answer from first.
    if domain == "vesopaepos.com":
        pub = f"/home/{USER}/web/{domain}/public_html"
        sh(client, f"test -d {pub} && cp {app}/public/vesopa-cookies.js {app}/public/vesopa-cookies.css {pub}/ "
                   f"&& chown {USER}:{USER} {pub}/vesopa-cookies.* || true", quiet=True)

    status, _ = sh(client, PM2.format(f"restart {domain}") + " >/dev/null && echo restarted")
    if status != 0:
        print(f"   ! pm2 restart failed — roll back with: tar -xzf {backup} -C {app}")
        return False
    time.sleep(4)

    ok = True
    for path, needle in [("/", "vesopa-cookies.js"), ("/vesopa-cookies.js", "VesopaCookies"), ("/vesopa-cookies.css", ".vck")]:
        url = f"https://{domain}{path}"
        try:
            code, body = fetch(url)
            good = code == 200 and needle in body
        except Exception as e:  # noqa: BLE001
            code, good = str(e), False
        print(f"   {'ok ' if good else 'BAD'} {url} -> {code}")
        # The gift site's home is a redirect to a venue shop with no footer of
        # its own on "/", so only the files are required there.
        if not good and not (domain == "gift.vesopaepos.com" and path == "/"):
            ok = False
    return ok


def main():
    check_only = "--check" in sys.argv
    client = vesopa_ssh.connect()
    results = {}
    try:
        for folder, domain in SITES:
            results[domain] = deploy(client, folder, domain, check_only)
    finally:
        client.close()
    print("\nSummary")
    for domain, ok in results.items():
        print(f"  {'OK  ' if ok else 'FAIL'} {domain}")
    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
