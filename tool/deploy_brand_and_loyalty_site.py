"""Rounded brand icons everywhere, and loyalty.vesopa.com's own page (2026-09-17).

    python tool/deploy_brand_and_loyalty_site.py

  1. back office (backoffice / menu / loyalty.vesopa.com): the loyalty website
     and its editor, the shared Continue with Vesopa module, the share tags on
     venue apps, rounded favicons, the web build, schema_loyalty_site.sql
  2. auth.vesopa.com: rounded favicons, the sign-in loading fixes, schema_022
     (the editor's redirect address) -- through vesopa_auth/scripts/deploy.py
  3. cloud.vesopa.com, vesopaepos.com, vesopasoftware.com: rounded favicons

Each Node app is restarted BY NAME afterwards: their pages stamp asset
versions at start-up, so a new icon is not asked for until they restart.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import migrate_old_box as m  # noqa: E402

USER = "vesopasoftware"
WEB = f"/home/{USER}/web"
BACKOFFICE = f"{WEB}/backoffice.vesopaepos.com/private/nodeapp"
def restart(name):
    return f"su - {USER} -c 'PM2_HOME=/home/{USER}/.pm2 pm2 restart {name} --update-env' >/dev/null && echo '    restarted {name}'"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


def put(files, remote_root):
    """Upload a set of files, keeping their paths relative to remote_root."""
    stage = pathlib.Path(tempfile.mkdtemp(prefix="brand-"))
    try:
        for local, rel in files:
            dst = stage / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / local, dst)
        # The staging folder itself is what is uploaded: `put` takes directories
        # only, and a single file path makes an empty directory of that name.
        env = {**os.environ, "MSYS_NO_PATHCONV": "1"}
        r = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "put", str(stage), remote_root],
                           cwd=str(ROOT), text=True, capture_output=True, env=env)
        out = (r.stdout or r.stderr).strip().splitlines()
        print("   ", out[-1] if out else "(no output)")
        if r.returncode:
            raise SystemExit(f"upload failed under {remote_root}")
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def backoffice():
    print("▶ back office")
    files = [(f"vesopa_server/src/{n}", f"src/{n}") for n in
             ["loyalty_host.js", "loyalty_site.js", "loyalty_app.js", "loyalty_account.js", "server.js", "vesopa_idtoken.js"]]
    files += [(f"vesopa_server/public/assets/{n}", f"public/assets/{n}") for n in ["favicon.png", "favicon.ico", "logo.png"]]
    site = ROOT / "vesopa_server/public/assets/loyalty-site"
    files += [(f"vesopa_server/public/assets/loyalty-site/{p.name}", f"public/assets/loyalty-site/{p.name}") for p in site.iterdir()]
    files += [("vesopa_server/schema/schema_loyalty_site.sql", "schema/schema_loyalty_site.sql")]
    put(files, BACKOFFICE)
    web = ROOT / "vesopa_loyalty/build/web"
    if '<base href="/__SLUG__/">' not in (web / "index.html").read_text(encoding="utf-8"):
        raise SystemExit("the web build is not built with --base-href /__SLUG__/")
    env = {**os.environ, "MSYS_NO_PATHCONV": "1"}
    subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "put", str(web), f"{BACKOFFICE}/loyalty_web"],
                   cwd=str(ROOT), env=env, check=True, capture_output=True)
    print("    web build uploaded")
    print(m.cloud(
        f"cd {BACKOFFICE} && chown -R {USER}:{USER} src public schema loyalty_web && "
        f"mariadb $(grep -E '^DB_NAME=' .env | cut -d= -f2) < schema/schema_loyalty_site.sql && echo '    schema ok' && "
        + restart("backoffice.vesopaepos.com")
    ).strip())


def auth():
    print("▶ auth.vesopa.com")
    r = subprocess.run([sys.executable, str(ROOT / "vesopa_auth/scripts/deploy.py")], cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", capture_output=True)
    for line in (r.stdout or "").splitlines():
        if line.startswith(("▶", "  ✓", "health", "login", "REFUSING", "  ok schema_022", "  FAILED")):
            print("   ", line)
    if r.returncode:
        print(r.stdout[-2000:], r.stderr[-2000:])
        raise SystemExit("auth deploy failed")


def sites():
    print("▶ cloud.vesopa.com")
    put([("vesopa_hosting/public/favicon.png", "favicon.png"), ("vesopa_hosting/public/favicon.ico", "favicon.ico")],
        f"{WEB}/cloud.vesopa.com/private/nodeapp/public")
    print(m.cloud(f"chown {USER}:{USER} {WEB}/cloud.vesopa.com/private/nodeapp/public/favicon.* && " + restart("cloud.vesopa.com")).strip())

    print("▶ vesopaepos.com")
    put([("vesopa_web/public/favicon.png", "favicon.png"), ("vesopa_web/public/favicon.ico", "favicon.ico"),
         ("vesopa_web/public/assets/logo/logo.png", "assets/logo/logo.png")],
        f"{WEB}/vesopaepos.com/private/nodeapp/public")
    print(m.cloud(f"chown -R {USER}:{USER} {WEB}/vesopaepos.com/private/nodeapp/public && " + restart("vesopaepos.com")).strip())

    print("▶ vesopasoftware.com")
    put([("vesopasoftware/site/favicon.ico", "favicon.ico"),
         ("vesopasoftware/site/assets/favicon.ico", "assets/favicon.ico"),
         ("vesopasoftware/site/assets/icon-32.png", "assets/icon-32.png"),
         ("vesopasoftware/site/assets/icon-192.png", "assets/icon-192.png"),
         ("vesopasoftware/site/assets/icon-512.png", "assets/icon-512.png")],
        f"{WEB}/vesopasoftware.com/private/nodeapp/site")
    print(m.cloud(f"chown -R {USER}:{USER} {WEB}/vesopasoftware.com/private/nodeapp/site && " + restart("vesopasoftware.com")).strip())


def checks():
    print("▶ checks")
    print(m.cloud(
        "sleep 5; for u in https://loyalty.vesopa.com/ https://loyalty.vesopa.com/admin https://loyalty.vesopa.com/thevesopakitchen/ "
        "https://loyalty.vesopa.com/assets/loyalty-site/og.png https://auth.vesopa.com/login https://cloud.vesopa.com/ "
        "https://vesopaepos.com/ https://vesopasoftware.com/ https://backoffice.vesopaepos.com/; do "
        "curl -sS -o /dev/null -w \"    %{http_code}  $u\\n\" $u; done; "
        "curl -s https://loyalty.vesopa.com/thevesopakitchen/ | grep -o '<meta property=\"og:[a-z]*\" content=\"[^\"]*\"' | head -4"
    ).strip())


if __name__ == "__main__":
    steps = {"backoffice": backoffice, "auth": auth, "sites": sites, "checks": checks}
    for name in (sys.argv[1:] or list(steps)):
        steps[name]()
