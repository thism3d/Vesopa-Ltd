"""Put account and data deletion live (2026-09-17).

    python tool/deploy_data_deletion.py

Both halves run on the cloud box (34.63.118.67) since the migration:

  1. a shared secret, made ON the server (root-only file), so it never passes
     through this machine or a chat
  2. auth.vesopa.com: vesopa_auth/scripts/deploy.py (upload, npm, schema_021,
     template check, restart, verify)
  3. the loyalty app's privacy provider registered in Vesopa Auth, pointing at
     the back office, with that secret
  4. backoffice.vesopaepos.com: src/privacy_provider.js, the two files that
     mount it, schema_privacy_requests.sql, VESOPA_PRIVACY_SECRET in .env,
     restart by name
  5. checks: the public page answers, an unsigned call is refused

Nothing here deletes anybody's data. The secret file is removed at the end.
"""
import pathlib
import subprocess
import sys
import tempfile
import shutil

ROOT = pathlib.Path(__file__).resolve().parents[1]
SSH = ROOT / "tool" / "auth_ssh.py"  # the cloud box; @app is auth.vesopa.com
BACKOFFICE = "/home/vesopasoftware/web/backoffice.vesopaepos.com/private/nodeapp"
AUTH = "/home/vesopasoftware/web/auth.vesopa.com/private/nodeapp"
SECRET = "/root/.vesopa_privacy_secret"
PM2 = "su - vesopasoftware -c 'PM2_HOME=/home/vesopasoftware/.pm2 pm2 {}'"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


def ssh(*args, check=True):
    env = {"MSYS_NO_PATHCONV": "1"}
    import os
    env = {**os.environ, **env}
    result = subprocess.run([sys.executable, str(SSH), *args], cwd=str(ROOT), text=True, capture_output=True, env=env)
    if result.stdout.strip():
        print(result.stdout.rstrip())
    if check and result.returncode != 0:
        print(result.stderr.rstrip(), file=sys.stderr)
        raise SystemExit(f"failed: {' '.join(args[:2])}")
    return result.stdout


def main():
    print("▶ shared secret (on the server)")
    ssh("run", f"umask 077; test -s {SECRET} || openssl rand -hex 32 > {SECRET}; echo \"  $(wc -c < {SECRET}) bytes\"")

    print("▶ auth.vesopa.com")
    done = subprocess.run([sys.executable, str(ROOT / "vesopa_auth" / "scripts" / "deploy.py")], cwd=str(ROOT))
    if done.returncode != 0:
        raise SystemExit("auth deploy failed; the back office was not touched")

    print("▶ registering the loyalty app's privacy provider")
    # The app user must read the secret to register it; a private copy, removed after.
    ssh("run", f"cp {SECRET} /tmp/.vps && chown vesopasoftware /tmp/.vps && chmod 600 /tmp/.vps && "
               f"su - vesopasoftware -c 'cd {AUTH} && node scripts/set-privacy-provider.js vesopa-loyalty "
               f"https://backoffice.vesopaepos.com/privacy/v1 /tmp/.vps Loyalty memberships'; rm -f /tmp/.vps")

    print("▶ backoffice.vesopaepos.com")
    stage = pathlib.Path(tempfile.mkdtemp(prefix="deletion-"))
    try:
        (stage / "src").mkdir()
        (stage / "schema").mkdir()
        for name in ["privacy_provider.js", "loyalty_app.js", "server.js"]:
            shutil.copy(ROOT / "vesopa_server" / "src" / name, stage / "src" / name)
        shutil.copy(ROOT / "vesopa_server" / "schema" / "schema_privacy_requests.sql", stage / "schema")
        ssh("put", str(stage / "src"), f"{BACKOFFICE}/src")
        ssh("put", str(stage / "schema"), f"{BACKOFFICE}/schema")
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    ssh("run",
        f"cd {BACKOFFICE} && chown -R vesopasoftware:vesopasoftware src schema && "
        f"(grep -q '^VESOPA_PRIVACY_SECRET=' .env || echo \"VESOPA_PRIVACY_SECRET=$(cat {SECRET})\" >> .env) && "
        f"mariadb $(grep -E '^DB_NAME=' .env | cut -d= -f2) < schema/schema_privacy_requests.sql && echo '  schema ok' && "
        + PM2.format("restart backoffice.vesopaepos.com --update-env") + " | tail -2")

    print("▶ checks")
    ssh("run",
        "sleep 4; "
        "curl -sS -o /dev/null -w 'delete-account page %{http_code}\\n' 'https://auth.vesopa.com/delete-account?app=vesopa-loyalty&venue=vesopa-test'; "
        "curl -sS -o /dev/null -w 'unsigned lookup      %{http_code} (expect 401)\\n' -X POST -H 'content-type: application/json' -d '{}' https://backoffice.vesopaepos.com/privacy/v1/lookup; "
        "curl -sS -o /dev/null -w 'loyalty app          %{http_code}\\n' https://menu.vesopaepos.com/loyalty/v1/app/vesopa-test; "
        f"rm -f {SECRET}; tail -3 {BACKOFFICE}/logs/error-0.log 2>/dev/null || true", check=False)


if __name__ == "__main__":
    main()
