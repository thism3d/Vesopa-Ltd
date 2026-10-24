"""Put Vesopa EPOS subscriptions live: vesopaepos.com billing + admin.vesopa.com Subscriptions.

    python tool/deploy_subscriptions.py --check   # what it would do; changes nothing
    python tool/deploy_subscriptions.py           # do it

Steps, stopping at the first failure:
  1. vesopaepos.com: back up, apply schema_subscriptions.sql to its own
     database (CREATE TABLE IF NOT EXISTS, safe to repeat).
  2. Keys, written only if missing, never printed:
       vesopaepos.com .env   DOJO_SUBS_KEY  = the shared Dojo SANDBOX key from
                                              .env.dojo-demo (DOJO_ONLINE_DEMO_KEY);
                                              refuses anything that is not sk_sandbox_
                             SUBS_SERVICE_KEY = a new random 48-byte key
       admin.vesopa.com .env SUBS_SERVICE_KEY = the same key
                             WEB_API          = http://127.0.0.1:<vesopaepos.com PORT>
  3. vesopaepos.com files via tool/deploy_vesopaepos_site.py (it refuses to
     overwrite a file changed on the server), then restart.
  4. admin.vesopa.com: back up, upload its changed files, restart.
  5. Check: /trial answers, admin /healthz answers.

Going live with real money later is one line: put Dojo's sk_prod_ key in
DOJO_SUBS_KEY on vesopaepos.com once Dojo has certified Vesopa EPOS.
"""
import pathlib
import posixpath
import secrets
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import deploy_websites_cookie_notice as base  # noqa: E402

ROOT = base.ROOT
USER = base.USER
WEB = f"/home/{USER}/web/vesopaepos.com/private/nodeapp"
ADMIN = f"/home/{USER}/web/admin.vesopa.com/private/nodeapp"
ADMIN_BASE = "218c4072"   # vesopa_admin as last deployed (unchanged before this work)


def sandbox_key():
    for line in (ROOT / ".env.dojo-demo").read_text(encoding="utf-8").splitlines():
        if line.startswith("DOJO_ONLINE_DEMO_KEY="):
            v = line.split("=", 1)[1].strip().strip("'\"")
            if not v.startswith("sk_sandbox_"):
                sys.exit("! DOJO_ONLINE_DEMO_KEY is not a sandbox key; refusing")
            return v
    sys.exit("! no DOJO_ONLINE_DEMO_KEY in .env.dojo-demo")


def env_has(client, path, key):
    st, out = base.sh(client, f"grep -c '^{key}=' {path}/.env || true", quiet=True)
    return out.strip() not in ("", "0")


def env_get(client, path, key):
    _, out = base.sh(client, f"grep '^{key}=' {path}/.env | tail -1 | cut -d= -f2-", quiet=True)
    return out.strip().strip("'\"")


def env_add(client, path, key, value):
    # value goes over stdin, never on the command line
    stdin, stdout, _ = client.exec_command(f"cat >> {path}/.env && chown {USER}:{USER} {path}/.env")
    stdin.write(f"\n{key}={value}\n")
    stdin.channel.shutdown_write()
    return stdout.channel.recv_exit_status() == 0


def admin_files():
    out = subprocess.run(["git", "diff", "--name-only", "--diff-filter=AM", f"{ADMIN_BASE}..HEAD", "--", "vesopa_admin"],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    return [f for f in out if "/node_modules/" not in f and not posixpath.basename(f).startswith(".env") and "/test/" not in f]


def main():
    check = "--check" in sys.argv
    key = sandbox_key()
    client = base.vesopa_ssh.connect()
    try:
        for p in (WEB, ADMIN):
            st, _ = base.sh(client, f"test -f {p}/.env", quiet=True)
            if st != 0:
                sys.exit(f"! {p}/.env not found")
        web_port = env_get(client, WEB, "PORT") or "5065"
        plan = {
            "web DOJO_SUBS_KEY": not env_has(client, WEB, "DOJO_SUBS_KEY"),
            "web SUBS_SERVICE_KEY": not env_has(client, WEB, "SUBS_SERVICE_KEY"),
            "admin SUBS_SERVICE_KEY": not env_has(client, ADMIN, "SUBS_SERVICE_KEY"),
            "admin WEB_API": not env_has(client, ADMIN, "WEB_API"),
        }
        files = admin_files()
        print(f"vesopaepos.com PORT {web_port}; keys to add: {[k for k, v in plan.items() if v] or 'none'}")
        print(f"admin.vesopa.com files ({len(files)}):\n   " + "\n   ".join(files))
        # Never overwrite an admin file someone changed on the server.
        sftp = client.open_sftp()
        drift = []
        for f in files:
            old = subprocess.run(["git", "show", f"{ADMIN_BASE}:{f}"], cwd=ROOT, capture_output=True)
            if old.returncode != 0:
                continue
            try:
                with sftp.file(posixpath.join(ADMIN, f[len("vesopa_admin") + 1:]), "rb") as rf:
                    live = rf.read()
            except IOError:
                continue
            if live.replace(b"\r\n", b"\n") != old.stdout.replace(b"\r\n", b"\n"):
                drift.append(f)
        sftp.close()
        if drift:
            sys.exit("! changed on the server since " + ADMIN_BASE + ", not overwritten: " + ", ".join(drift))
        if check:
            print("\ncheck only: nothing changed.")
            return

        stamp = time.strftime("%Y%m%d-%H%M%S")
        for p, name in ((WEB, "vesopaepos.com"), (ADMIN, "admin.vesopa.com")):
            st, _ = base.sh(client, f"mkdir -p {base.BACKUPS} && tar -czf {base.BACKUPS}/{name}-{stamp}-subs.tgz -C {p} "
                                    "--exclude=./node_modules --exclude=./uploads --exclude=./logs --exclude=./backup --exclude=./releases .")
            if st != 0:
                sys.exit(f"! backup of {name} failed; nothing changed")
        print(f"backups: {base.BACKUPS}/*-{stamp}-subs.tgz")

        # 1. schema
        sftp = client.open_sftp()
        sftp.put(str(ROOT / "vesopa_web" / "schema_subscriptions.sql"), f"{WEB}/schema_subscriptions.sql")
        sftp.close()
        # Through the app's own mysql2 + dotenv: the .env has values with spaces
        # that a shell `. ./.env` mangles (that broke the first try).
        js = ("require('dotenv').config({path:'.env',quiet:true});const m=require('mysql2/promise');(async()=>{"
              "const c=await m.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:+process.env.DB_PORT||3306,"
              "user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME||'vesopa_eposdb',multipleStatements:true});"
              "await c.query(require('fs').readFileSync('schema_subscriptions.sql','utf8'));"
              "const [t]=await c.query(\"SHOW TABLES LIKE 'web_sub%'\");console.log('schema applied:',t.map(r=>Object.values(r)[0]).join(', '));await c.end();})()"
              ".catch(e=>{console.error(e.message);process.exit(1)})")
        sftp = client.open_sftp()
        with sftp.file(f"{WEB}/zz-apply-subs-schema.js", "w") as fh:
            fh.write(js)
        sftp.close()
        st, _ = base.sh(client, f"cd {WEB} && PATH=/opt/nodejs/24/bin:$PATH node zz-apply-subs-schema.js; s=$?; rm -f zz-apply-subs-schema.js; exit $s")
        if st != 0:
            sys.exit("! schema failed; files not changed (backups kept)")

        # 2. keys
        shared = env_get(client, ADMIN, "SUBS_SERVICE_KEY") or env_get(client, WEB, "SUBS_SERVICE_KEY") or secrets.token_hex(48)
        if plan["web DOJO_SUBS_KEY"]:
            env_add(client, WEB, "DOJO_SUBS_KEY", key)
        if plan["web SUBS_SERVICE_KEY"]:
            env_add(client, WEB, "SUBS_SERVICE_KEY", shared)
        if plan["admin SUBS_SERVICE_KEY"]:
            env_add(client, ADMIN, "SUBS_SERVICE_KEY", shared)
        if plan["admin WEB_API"]:
            env_add(client, ADMIN, "WEB_API", f"http://127.0.0.1:{web_port}")
        print("keys in place (not printed)")

        # 4. admin files (web goes through its own guarded script below)
        sftp = client.open_sftp()
        for f in files:
            dest = posixpath.join(ADMIN, f[len("vesopa_admin") + 1:])
            base.vesopa_ssh._mkdirs(sftp, posixpath.dirname(dest))
            sftp.put(str(ROOT / f), dest)
        sftp.close()
        base.sh(client, f"chown -R {USER}:{USER} {ADMIN}", quiet=True)
        base.sh(client, base.PM2.format("restart admin.vesopa.com") + " >/dev/null && echo admin restarted")
    finally:
        client.close()

    # 3. vesopaepos.com files + restart, with its drift guard
    r = subprocess.run([sys.executable, str(ROOT / "tool" / "deploy_vesopaepos_site.py")], cwd=ROOT)
    if r.returncode not in (0, 1):
        sys.exit("! vesopaepos.com files not deployed (see above)")

    time.sleep(4)
    for url, needle in (("https://vesopaepos.com/trial", "Start your trial"), ("https://admin.vesopa.com/healthz", '"ok":true')):
        try:
            code, body = base.fetch(url)
            print(f"   {'ok ' if code == 200 and needle in body else 'BAD'} {url} -> {code}")
        except Exception as e:  # noqa: BLE001
            print(f"   BAD {url} -> {e}")


if __name__ == "__main__":
    main()
