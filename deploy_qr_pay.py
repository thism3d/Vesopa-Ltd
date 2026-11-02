"""Deploy QR Pay and the practice-copy fix to the live back office (2026-11-02).

Run from the repository root in PowerShell:  python deploy_qr_pay.py
It uploads six files, checks them, restarts the back office, checks it is up,
then re-copies Pontardawe RFC's practice venue from the live one (the live
venue is only read). The live files were backed up first to
C:/Users/azureuser/VesopaBackups/server-2026-11-02-qrpay.
"""
import os
import shutil
import subprocess
import sys

os.environ["MSYS_NO_PATHCONV"] = "1"
SSH = [sys.executable, ".claude/skills/vesopa-ops/scripts/vesopa_ssh.py"]
APP = "/home/vesopasoftware/web/backoffice.vesopaepos.com/private/nodeapp"
UP = "C:/Users/azureuser/gtmp/up_qr"


def run(*args):
    print(">", " ".join(args[:3]))
    r = subprocess.run([*SSH, *args], text=True, capture_output=True)
    print(r.stdout.strip() or r.stderr.strip())
    if r.returncode:
        sys.exit("Stopped: that step failed.")
    return r.stdout


shutil.rmtree(UP, ignore_errors=True)
os.makedirs(f"{UP}/src")
os.makedirs(f"{UP}/public")
for f in ["qr_pay.js", "server.js", "tap.js", "demo_venue.js"]:
    shutil.copy(f"vesopa_server/src/{f}", f"{UP}/src/{f}")
for f in ["app.js", "index.html"]:
    shutil.copy(f"vesopa_server/public/{f}", f"{UP}/public/{f}")

run("put", f"{UP}/src", f"{APP}/src")
run("put", f"{UP}/public", f"{APP}/public")
run("run", f"""cd {APP}
chown vesopasoftware:vesopasoftware src/qr_pay.js src/server.js src/tap.js src/demo_venue.js public/app.js public/index.html
for f in src/qr_pay.js src/server.js src/tap.js src/demo_venue.js public/app.js; do node --check $f || {{ echo BAD $f; exit 1; }}; done
su - vesopasoftware -c 'pm2 restart backoffice.vesopaepos.com --update-env' >/dev/null && echo restarted
sleep 8
curl -s -o /dev/null -w 'health %{{http_code}}\\n' https://backoffice.vesopaepos.com/health
curl -s -o /dev/null -w 'pay page (expect 404) %{{http_code}}\\n' https://menu.pontardawerfc.com/pay/000000000000000000000000""")

# Re-copy Pontardawe RFC's practice venue (office 62) from the live one (35).
run("run", f"""cd {APP}
su vesopasoftware -s /bin/bash -c "node -e \\"require('dotenv').config({{quiet:true}}); const mysql=require('mysql2/promise'); const d=require('./src/demo_venue'); (async()=>{{ const db=mysql.createPool({{host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME}}); const demo='demo.35@vesopa.invalid'; await d.clearSetup(db, demo, 62); const r=await d.cloneSetup(db,{{fromEmail:'info@vesopa.com',toEmail:demo}}); console.log(r.filter(x=>x.rows).map(x=>x.table+' '+x.rows).join(', ')); process.exit(0) }})().catch(e=>{{console.log('FAILED',e.message);process.exit(1)}})\\"" """)
print("Done.")
