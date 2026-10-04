"""Put venue modules and memberships live (2026-10-04).

    python tool/deploy_memberships.py

Run from the repository root on the owner's Windows folder (cloud sessions
cannot reach port 22). It:

  1. back office (backoffice.vesopaepos.com): uploads vesopa_server/src,
     public and the three new schema files, applies
     schema_venue_modules.sql, schema_memberships.sql and
     schema_till_express_memberships.sql (all re-runnable),
     restarts by name
  2. Metric Membership (metric.vesopa.com): MetricMembership/server/scripts/
     deploy.py --apply, which bundles, runs npm ci, applies its schema and
     restarts. Without EPOS_BASE_URL and EPOS_PARTNER_KEY in its .env it keeps
     running standalone, exactly as before.
  3. checks: health, a module route refusing an unsigned call, the error log

Nothing here changes any venue's data: the schema adds tables and columns,
and the only rows it writes are the default module prices and the gym door
for venues that already run the gym.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
USER = "vesopasoftware"
BACKOFFICE = f"/home/{USER}/web/backoffice.vesopaepos.com/private/nodeapp"
SCHEMAS = ["schema_venue_modules.sql", "schema_memberships.sql", "schema_till_express_memberships.sql"]
PM2 = f"su - {USER} -c 'PM2_HOME=/home/{USER}/.pm2 pm2 {{}}'"

def load_env_claude():
    """Read the server login from .env.claude when .env.claude-tools is absent.

    The SSH helper reads .env.claude-tools; on the owner's PC the login lives in
    .env.claude. Fills only keys not already set, and never prints a value.
    """
    path = ROOT / ".env.claude"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))
    if "VESOPA_SSH_HOST" not in os.environ and os.environ.get("VESOPA_SERVER_SSH"):
        os.environ["VESOPA_SSH_HOST"] = os.environ["VESOPA_SERVER_SSH"]


load_env_claude()

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


def ssh(*args, check=True):
    env = {**os.environ, "MSYS_NO_PATHCONV": "1"}
    r = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), *args],
                       cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", capture_output=True, env=env)
    if r.stdout.strip():
        print(r.stdout.rstrip())
    if check and r.returncode != 0:
        print(r.stderr.rstrip(), file=sys.stderr)
        raise SystemExit(f"failed: {' '.join(args[:2])}")
    return r.stdout


def stage_dir(src, dst):
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("node_modules", "*.log", ".DS_Store"))


def backoffice():
    print("▶ back office: upload")
    stage = pathlib.Path(tempfile.mkdtemp(prefix="memberships-"))
    try:
        server = ROOT / "vesopa_server"
        stage_dir(server / "src", stage / "src")
        stage_dir(server / "public", stage / "public")
        (stage / "schema").mkdir()
        for name in SCHEMAS:
            shutil.copy(server / "schema" / name, stage / "schema" / name)
        for part in ["src", "public", "schema"]:
            ssh("put", str(stage / part), f"{BACKOFFICE}/{part}")
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    print("▶ back office: schema and restart")
    apply = " && ".join(
        f"mariadb $(grep -E '^DB_NAME=' .env | cut -d= -f2) < schema/{name} && echo '  {name} ok'" for name in SCHEMAS)
    ssh("run",
        f"cd {BACKOFFICE} && chown -R {USER}:{USER} src public schema && {apply} && "
        + PM2.format("restart backoffice.vesopaepos.com --update-env") + " | tail -2")


def metric():
    print("▶ Metric Membership")
    r = subprocess.run([sys.executable, str(ROOT / "MetricMembership" / "server" / "scripts" / "deploy.py"), "--apply"],
                       cwd=str(ROOT))
    if r.returncode:
        raise SystemExit("Metric deploy failed (the back office is already live and unaffected)")


def checks():
    print("▶ checks")
    ssh("run",
        "sleep 5; "
        "curl -sS -o /dev/null -w 'back office health       %{http_code}\\n' https://backoffice.vesopaepos.com/health; "
        "curl -sS -o /dev/null -w 'memberships, unsigned    %{http_code} (expect 401)\\n' https://backoffice.vesopaepos.com/api/memberships/summary; "
        "curl -sS -o /dev/null -w 'partner API, no key      %{http_code} (expect 401)\\n' https://backoffice.vesopaepos.com/partner/v1/memberships/plans; "
        "curl -sS -o /dev/null -w 'metric health            %{http_code}\\n' https://metric.vesopa.com/health; "
        f"tail -5 {BACKOFFICE}/logs/error-0.log 2>/dev/null || true", check=False)


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    if only in ("", "--backoffice"):
        backoffice()
    if only in ("", "--metric"):
        metric()
    checks()
