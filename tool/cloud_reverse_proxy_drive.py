"""Turn on "Show another website here" for a domain, through cloud.vesopa.com (2026-10-19).

    python tool/cloud_reverse_proxy_drive.py pontardawerfcmenu.vesopa.com https://menu.pontardawerfc.com
    python tool/cloud_reverse_proxy_drive.py pontardawerfcmenu.vesopa.com off

Signs in to the panel as the customer who owns the domain (the way
setup_pontardawe_menu.py does) and presses the same button a customer
presses, so the feature is exercised end to end rather than bypassed.
"""
import sys
import time

import setup_pontardawe_menu as menu  # noqa: E402  (panel session helpers)


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    domain, target = sys.argv[1].lower(), sys.argv[2]
    client = menu.app.vesopa_ssh.connect()
    try:
        row = menu.cloud_sql(client, f"SELECT id, customer_id FROM domains WHERE domain='{domain}' LIMIT 1")
        if not row:
            raise SystemExit(f"! {domain} is not in the panel")
        domain_id, customer = row[0][0], int(row[0][1])
        menu.CUSTOMER = customer
        s = menu.mint(client)
        page = s.get(f"{menu.CLOUD}/panel/domains/{domain_id}", timeout=60)
        print(f"   domain page: {page.status_code}, card shown: {'Show another website here' in page.text}")
        data = {"_csrf": s.cookies.get("vh_csrf")}
        if target == "off":
            data["action"] = "clear"
        else:
            data["target"] = target
        r = s.post(f"{menu.CLOUD}/panel/domains/{domain_id}/reverse-proxy", data=data, allow_redirects=True, timeout=180)
        print(f"   pressed: {r.status_code}")
        time.sleep(2)
        print("   stored:", menu.cloud_sql(client, f"SELECT reverse_proxy FROM domains WHERE id={domain_id}"))
        print("   node:  ", menu.out(client, menu.H + f"v-list-web-domain {menu.USER} {domain} | grep -E '^PROXY:'"))
    finally:
        client.close()


if __name__ == "__main__":
    main()
