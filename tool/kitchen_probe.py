"""Sign in as a kitchen screen and call everything the kitchen app loads.

    python tool/kitchen_probe.py

Asks for the venue (office), the kitchen user name and its password (typed
privately, never shown or saved), signs in exactly as Vesopa Kitchen does, then
calls each address the app reads and says which one does not answer with data
(the kitchen screen's "FormatException: Unexpected character"). Read-only: it
signs in and reads, nothing else.
"""
import getpass
import json
import sys
import urllib.error
import urllib.request

BASE = "https://backoffice.vesopaepos.com"


def call(method, path, token=None, body=None):
    headers = {"Accept": "application/json", "User-Agent": "VesopaKitchen-probe"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read().decode("utf-8", "replace")


def main():
    office = input("Venue (office email, e.g. info@vesopa.com): ").strip() or "info@vesopa.com"
    user = input("Kitchen user name: ").strip()
    password = getpass.getpass("Password (not shown): ")
    st, ct, body = call("POST", "/api/kitchen/login", body={"office": office, "username": user, "password": password})
    try:
        token = json.loads(body).get("token")
    except ValueError:
        token = None
    print(f"sign-in: {st}")
    if not token:
        print("  could not sign in:", body[:200])
        sys.exit(1)
    paths = [
        "/api/kitchen/profile", "/api/kitchen/board?minutes=60", "/api/kitchen/dinein/orders?status=placed&limit=30",
        "/api/kitchen/stock/availability", "/api/licence/state", "/api/kitchen/branding",
        f"/api/till-settings/public?office={urllib.request.quote(office)}", "/api/allergens",
    ]
    for p in paths:
        st, ct, body = call("GET", p, token)
        try:
            json.loads(body)
            verdict = "data ok"
        except ValueError:
            verdict = "NOT DATA: " + body[:120].replace("\n", " ")
        print(f"  {st} {p:<55} {verdict}")


if __name__ == "__main__":
    main()
