"""End-to-end check of the till's new staff routes against the live server.

The two routes nothing else exercises: `POST /till/staff` and
`GET /till/permission-groups`, both on a terminal token. A terminal token is
obtained the way the till gets one — by signing in with `terminal: true` — and
everything created is deleted afterwards through the back office, in a
`finally`, so a failed expectation still tidies up.

    python tool/live_till_staff_check.py
"""
import json
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = "https://backoffice.vesopaepos.com"
MARK = "Claude till check"
# Four digits nobody at the venue is likely to hold, checked for anyway.
PIN = "8137"


def env():
    values = {}
    for line in (ROOT / ".env.claude-tools").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def call(path, method="GET", body=None, token=None):
    req = urllib.request.Request(
        f"{BASE}{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            return e.code, json.loads(text)
        except json.JSONDecodeError:
            return e.code, text[:300]


PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{(' — ' + str(detail)) if detail else ''}")


def main():
    cfg = env()
    status, login = call(
        "/api/login",
        "POST",
        {
            "email": cfg["VESOPA_TEST_EMAIL"],
            "password": cfg["VESOPA_TEST_PASSWORD"],
            # What the till sends when it is commissioned.
            "terminal": True,
        },
    )
    if status != 200:
        print("sign-in failed:", status, login)
        raise SystemExit(1)
    office = login["token"]
    terminal = login.get("terminalToken")
    check("signing in as a terminal yields a terminal token", bool(terminal))
    if not terminal:
        raise SystemExit(1)

    made = []
    try:
        # ---- The roles the till offers ------------------------------------
        status, roles = call("/till/permission-groups", token=terminal)
        check("a terminal can read the venue's roles", status == 200, status)
        check("and they come back as id and name",
              isinstance(roles, list)
              and all({"id", "name"} <= set(r) for r in roles),
              roles)

        # ---- A terminal token, and nothing else, opens the route -----------
        status, res = call("/till/staff", "POST", {"name": "x"}, None)
        check("no token is refused", status == 401, status)
        status, res = call("/till/staff", "POST", {"name": "x"}, office)
        check("a back-office token is refused too", status in (401, 403), status)

        # ---- The PIN rules, which have to match the back office -------------
        status, res = call(
            "/till/staff", "POST", {"name": MARK, "pin": "123"}, terminal)
        check("a three-digit PIN is refused", status == 400, res)
        status, res = call(
            "/till/staff", "POST", {"name": MARK, "pin": "12345"}, terminal)
        check("a five-digit PIN is refused", status == 400, res)
        status, res = call("/till/staff", "POST", {"name": "  "}, terminal)
        check("a blank name is refused", status == 400, res)
        status, res = call(
            "/till/staff",
            "POST",
            {"name": MARK, "permission_group_id": 999999},
            terminal,
        )
        check("a role from another venue is refused", status == 400, res)

        # ---- The happy path -------------------------------------------------
        status, made_one = call(
            "/till/staff",
            "POST",
            {
                "name": f"{MARK} 1",
                "pin": PIN,
                "permission_group_id": roles[0]["id"] if roles else None,
            },
            terminal,
        )
        check("a terminal can take somebody on", status == 201, made_one)
        if status == 201:
            made.append(made_one["id"])
            check("…and is handed a pluid to file them under",
                  isinstance(made_one.get("pluid"), int) and made_one["pluid"] > 0,
                  made_one.get("pluid"))

        # ---- Two people cannot share four digits ----------------------------
        status, res = call(
            "/till/staff", "POST", {"name": f"{MARK} 2", "pin": PIN}, terminal)
        check("a PIN already in use is a 409", status == 409, status)
        check("…and the refusal names who holds it",
              status == 409 and f"{MARK} 1" in str(res.get("error")), res)

        # ---- Somebody with no PIN, for the swipe-a-card half ----------------
        status, no_pin = call(
            "/till/staff", "POST", {"name": f"{MARK} 3"}, terminal)
        check("somebody can be created without a PIN, for a card", status == 201,
              no_pin)
        if status == 201:
            made.append(no_pin["id"])

        # ---- And the till can see them ---------------------------------------
        status, staff = call("/till/staff", token=terminal)
        names = [s["name"] for s in (staff or [])]
        check("the new starter is on the staff list the till reads",
              f"{MARK} 1" in names)
        # The PIN-less one is filtered out by the till itself, not by the
        # server: the server sends everybody, and the till drops anyone who
        # cannot sign on. Asserted here so that stays true.
        check("and so is the one with no PIN, for the till to filter",
              f"{MARK} 3" in names)

    finally:
        for sid in made:
            call(f"/api/staff/{sid}", "DELETE", token=office)
        status, staff = call("/api/staff", token=office)
        left = [s for s in (staff or []) if str(s["clark_name"]).startswith(MARK)]
        print(f"\nscratch staff left behind: {len(left)}")
        if left:
            FAIL.append("teardown left rows behind")

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        for f in FAIL:
            print("  FAILED:", f)
        sys.exit(1)


if __name__ == "__main__":
    main()
