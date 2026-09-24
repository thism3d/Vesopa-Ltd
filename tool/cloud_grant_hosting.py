"""Give a customer a hosting plan through the product's own checkout.

    python tool/cloud_grant_hosting.py <customer id> <plan slug> <months> <coupon code> "<First>" "<Last>" <country>

The admin saves a 100 %% discount code (idempotent), the customer puts the
plan in their basket, applies the code, and checks out at £0 — which the
product treats as "no payment needed, order confirmed" and provisions on the
spot. No payment reference is invented and no gateway is touched. Used when
the owner moves a customer from another server and the hosting is his gift.
"""

import re
import subprocess
import sys
import time

import requests

ROOT = __import__("pathlib").Path(__file__).resolve().parents[1]
CLOUD = "https://cloud.vesopa.com"
customer_id, plan, months, code, first, last, country = sys.argv[1:8]


def cloud(cmd):
    r = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), "run", cmd], cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", capture_output=True)
    return (r.stdout or "") + (r.stderr or "")


def mint(kind, row_id):
    table, fn = ("hosting_admins", "issueAdminSession") if kind == "admin" else ("customers", "issueCustomerSession")
    cmd = (
        "cd @app && su - vesopasoftware -c 'cd /home/vesopasoftware/web/cloud.vesopa.com/private/nodeapp && "
        "node -e \"require(\\\"dotenv\\\").config(); const db=require(\\\"./src/db\\\"),auth=require(\\\"./src/auth\\\"); "
        f"db.one(\\\"SELECT * FROM {table} WHERE id={row_id}\\\").then(c=>{{auth.{fn}({{cookie:(n,v)=>console.log(\\\"COOKIE \\\"+v)}},c);process.exit(0)}})\"'"
    )
    out = cloud(cmd)
    token = next((l.split(" ", 1)[1].strip() for l in out.splitlines() if l.startswith("COOKIE ")), "")
    if not token:
        raise SystemExit("could not mint a session:\n" + out)
    s = requests.Session()
    s.cookies.set("vh_admin" if kind == "admin" else "vh_session", token, domain="cloud.vesopa.com")
    return s


# 1. The discount code, saved by the admin (owner account, id 1).
admin = mint("admin", 1)
admin.get(f"{CLOUD}/admin/coupons")
r = admin.post(f"{CLOUD}/admin/coupons", data={
    "_csrf": admin.cookies.get("vh_csrf"), "code": code, "description": "Hosting moved from the old server — complimentary",
    "kind": "percent", "value": "100", "min_spend": "0", "applies_to": "hosting", "max_uses": "0",
}, allow_redirects=False)
print("coupon:", r.status_code, r.headers.get("location"))

# 2. The customer: plan → basket → code → checkout at £0.
cust = mint("customer", customer_id)
r = cust.get(f"{CLOUD}/order/{plan}?term={months}", allow_redirects=False)
print("basket:", r.status_code, r.headers.get("location"))
cust.get(f"{CLOUD}/cart")
r = cust.post(f"{CLOUD}/cart/coupon", data={"_csrf": cust.cookies.get("vh_csrf"), "code": code}, allow_redirects=False)
print("code applied:", r.status_code)
page = cust.get(f"{CLOUD}/checkout")
total = re.search(r"Total[^£]*£\s*([\d.,]+)", re.sub(r"<[^>]+>", " ", page.text))
print("checkout total:", total.group(1) if total else "?")
r = cust.post(f"{CLOUD}/checkout", data={
    "_csrf": cust.cookies.get("vh_csrf"), "first_name": first, "last_name": last, "company": "", "phone": "",
    "address1": "-", "address2": "", "city": "-", "postcode": "-", "country": country, "bill_same": "1",
}, allow_redirects=False)
print("checkout:", r.status_code, r.headers.get("location"))
order = re.search(r"/panel/setup/(\d+)", r.headers.get("location", ""))
if not order:
    txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))
    print("errors:", re.findall(r'class="error-text">([^<]*)', r.text), "|", re.findall(r"alert-error[^>]*>.*?<div>([^<]*)", r.text, re.S))
    raise SystemExit(1)
oid = order.group(1)

# 3. Provisioning: the setup page starts it and reports each step.
cust.post(f"{CLOUD}/panel/setup/{oid}/start", json={"_csrf": cust.cookies.get("vh_csrf")})
for _ in range(60):
    st = cust.get(f"{CLOUD}/panel/setup/{oid}/status").json()
    if st.get("finished"):
        break
    time.sleep(3)
for s in st.get("steps", []):
    print(f"   {s['status']:8s} {s['label']} — {s.get('detail','')}")
print("order", oid, "finished:", st.get("finished"), "failed:", st.get("failed"))
