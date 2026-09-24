"""Move the loyalty app to loyalty.vesopa.com (2026-09-17).

    python tool/deploy_loyalty_domain.py domain     # web domain, proxy, certificate
    python tool/deploy_loyalty_domain.py backoffice # code, web build, .env, the venue's address

The owner's decision: every venue's app lives at loyalty.vesopa.com/<venue>, and
The Vesopa Kitchen's address is `thevesopakitchen` -- no alias for the old
`vesopa-test`. menu.vesopaepos.com/app/<venue>/ redirects to the new address
(src/loyalty_host.js).

loyalty.vesopa.com's A record already points at the cloud box (DNS is at
phase8, not ours). The name is added through the panel exactly as the
migration added menu.vesopaepos.com, then proxied to the back office's port.
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
DOMAIN = "loyalty.vesopa.com"
BACKOFFICE = f"/home/{USER}/web/backoffice.vesopaepos.com/private/nodeapp"
PORT = 20005
OFFICE = "manager@vesopa.co.uk"
NEW_SLUG = "thevesopakitchen"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


def put(local, remote):
    env = {**os.environ, "MSYS_NO_PATHCONV": "1"}
    r = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "put", str(local), remote],
                       cwd=str(ROOT), text=True, capture_output=True, env=env)
    print("   ", (r.stdout or r.stderr).strip().splitlines()[-1] if (r.stdout or r.stderr).strip() else "(no output)")
    if r.returncode:
        raise SystemExit(f"upload failed: {local}")


def domain():
    print("▶ web domain")
    if not m.web_domain_exists(USER, DOMAIN):
        m.panel_add_domain(m.mint(3), DOMAIN)
    else:
        print(f"    {DOMAIN} already on the node")
    m.proxy_to_port(USER, DOMAIN, PORT)
    ssl = m.hestia(f"v-list-web-domain {USER} {DOMAIN} json | grep '\"SSL\"'")
    if '"yes"' not in ssl:
        print("▶ certificate")
        print("   ", m.hestia(f"v-add-letsencrypt-domain {USER} {DOMAIN} '' no 2>&1 | tail -2").strip())
    print(m.cloud(f"sleep 2; curl -sS -o /dev/null -w '    https://{DOMAIN}/health %{{http_code}}\\n' https://{DOMAIN}/health"))


def backoffice():
    print("▶ back office code")
    stage = pathlib.Path(tempfile.mkdtemp(prefix="loyalty-host-"))
    try:
        (stage / "src").mkdir()
        (stage / "public").mkdir()
        (stage / "tool").mkdir()
        for name in ["loyalty_host.js", "loyalty_app.js", "loyalty_account.js", "server.js"]:
            shutil.copy(ROOT / "vesopa_server" / "src" / name, stage / "src" / name)
        shutil.copy(ROOT / "vesopa_server" / "public" / "index.html", stage / "public" / "index.html")
        for name in ["seed-demo-loyalty.js", "verify-loyalty-look-live.js"]:
            shutil.copy(ROOT / "vesopa_server" / "tool" / name, stage / "tool" / name)
        put(stage / "src", f"{BACKOFFICE}/src")
        put(stage / "public", f"{BACKOFFICE}/public")
        put(stage / "tool", f"{BACKOFFICE}/tool")
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    web = ROOT / "vesopa_loyalty" / "build" / "web"
    index = (web / "index.html").read_text(encoding="utf-8")
    if '<base href="/__SLUG__/">' not in index:
        raise SystemExit("the web build is not built with --base-href /__SLUG__/")
    print("▶ web app")
    m.cloud(f"cd {BACKOFFICE} && rm -rf backup/loyalty_web.pre-domain && cp -a loyalty_web backup/loyalty_web.pre-domain")
    put(web, f"{BACKOFFICE}/loyalty_web")

    print("▶ .env, the venue's address, restart")
    out = m.cloud(
        f"cd {BACKOFFICE} && chown -R {USER}:{USER} src public tool loyalty_web && "
        f"for kv in LOYALTY_HOST={DOMAIN} LOYALTY_RP_ID={DOMAIN}; do k=${{kv%%=*}}; "
        f"grep -q \"^$k=\" .env && sed -i \"s|^$k=.*|$kv|\" .env || echo \"$kv\" >> .env; done; "
        f"mariadb vesopasoftware_eposdb -e \"UPDATE epos_loyalty_app SET slug = '{NEW_SLUG}' WHERE office = '{OFFICE}'; "
        f"SELECT slug, app_name FROM epos_loyalty_app WHERE office = '{OFFICE}'\" 2>&1 | grep -v Deprecated; "
        f"su - {USER} -c 'PM2_HOME=/home/{USER}/.pm2 pm2 restart backoffice.vesopaepos.com --update-env' >/dev/null; sleep 5; "
        f"for u in https://{DOMAIN}/{NEW_SLUG}/ https://{DOMAIN}/loyalty/v1/app/{NEW_SLUG} "
        f"https://menu.vesopaepos.com/app/{NEW_SLUG}/ https://{DOMAIN}/ https://{DOMAIN}/api/offices; do "
        f"curl -sS -o /dev/null -w \"    %{{http_code}} %{{redirect_url}}  $u\\n\" $u; done; "
        f"curl -s https://{DOMAIN}/{NEW_SLUG}/ | grep -o '<base href=\"[^\"]*\">'"
    )
    print(out)


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else ""
    {"domain": domain, "backoffice": backoffice}.get(step, lambda: print(__doc__))()
