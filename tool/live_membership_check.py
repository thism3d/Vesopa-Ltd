"""End-to-end check of the 1.6.8.0 membership work against the live server.

Creates its own customers under an address nobody trades under, drives the real
routes, and deletes only the ids it created — in a `finally`, so a failed
expectation still cleans up. Signs in as the test account and touches no other
record.

    python tool/live_membership_check.py
"""
import datetime
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = "https://backoffice.vesopaepos.com"
MARK = "Claude 1.6.8.0 check"


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
            return e.code, text[:400]


PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{(' — ' + str(detail)) if detail else ''}")


def main():
    cfg = env()
    status, login = call(
        "/api/login",
        "POST",
        {"email": cfg["VESOPA_TEST_EMAIL"], "password": cfg["VESOPA_TEST_PASSWORD"]},
    )
    if status != 200:
        print("sign-in failed:", status, login)
        raise SystemExit(1)
    token = login["token"]
    office = cfg.get("VESOPA_TEST_EMAIL")
    print("signed in as the test account")

    made = []
    try:
        # ---- Two scratch members ------------------------------------------
        for i in (1, 2):
            status, res = call(
                "/api/customers",
                "POST",
                {
                    "name": f"{MARK} {i}",
                    "email": f"claude-{i}@vesopa.invalid",
                    "membership_expiry": "2020-01-01",
                },
                token,
            )
            check(f"created scratch member {i}", status == 201, status)
            if status == 201:
                made.append(res["id"])

        # ---- The bulk expiry edit -----------------------------------------
        status, res = call(
            "/api/customers/bulk",
            "PATCH",
            {"ids": made, "fields": {"membership_expiry": "2027-03-31"}},
            token,
        )
        check("bulk edit accepted", status == 200, res)
        check("bulk edit touched exactly the two", res and res.get("updated") == 2, res)

        status, rows = call("/api/customers", token=token)
        ours = {r["id"]: r for r in rows if r["id"] in made}
        check(
            "both expiries now read 2027-03-31",
            all(c["membership_expiry"] == "2027-03-31" for c in ours.values()),
            [c["membership_expiry"] for c in ours.values()],
        )
        others = [r for r in rows if r["id"] not in made and r.get("membership_expiry")]
        check("no other customer was given an expiry", not others, len(others))

        status, res = call(
            "/api/customers/bulk",
            "PATCH",
            {"ids": made, "fields": {"membership_expiry": "2026-02-30"}},
            token,
        )
        check("a date that is not a day is refused", status == 400, res)

        status, res = call(
            "/api/customers/bulk", "PATCH", {"ids": [], "fields": {}}, token
        )
        check("an empty selection is refused", status == 400, res)

        # ---- The photograph round-trips ------------------------------------
        status, res = call(
            f"/api/customers/{made[0]}",
            "PUT",
            {
                "name": f"{MARK} 1",
                "email": "claude-1@vesopa.invalid",
                "membership_expiry": "2027-03-31",
                "photo_url": "/uploads/not-a-real-file.png",
            },
            token,
        )
        check("a photo saves on a customer", status == 200, res)

        query = urllib.parse.urlencode({"office": office, "q": MARK})
        status, found = call(f"/api/loyalty/search?{query}")
        mine = [c for c in (found or []) if c["id"] == made[0]]
        check("the till's search carries photo_url", bool(mine) and "photo_url" in mine[0])
        check(
            "and it is the URL that was saved",
            bool(mine) and mine[0]["photo_url"] == "/uploads/not-a-real-file.png",
            mine[0]["photo_url"] if mine else None,
        )
        check(
            "and the expiry travels with it",
            bool(mine) and str(mine[0]["membership_expiry"]).startswith("2027-03-31"),
            mine[0]["membership_expiry"] if mine else None,
        )

        # ---- Renewal --------------------------------------------------------
        status, settings = call("/api/loyalty/public?" + urllib.parse.urlencode({"office": office}))
        check(
            "the till is told the term and the fee",
            settings.get("membership_term_months") is not None
            and settings.get("membership_fee_minor") is not None,
            {k: settings.get(k) for k in ("membership_term_months", "membership_fee_minor")},
        )
        term = int(settings["membership_term_months"])

        # An expired member renews from today.
        call(
            "/api/customers/bulk",
            "PATCH",
            {"ids": [made[1]], "fields": {"membership_expiry": "2020-01-01"}},
            token,
        )
        status, res = call(
            "/api/loyalty/renew", "POST", {"office": office, "customer_id": made[1]}
        )
        today = datetime.date.today()
        month = today.month - 1 + term
        want = today.replace(
            year=today.year + month // 12,
            month=month % 12 + 1,
            day=min(today.day, 28),
        )
        check("an expired member renews", status == 200, res)
        check(
            f"…to about today + {term} months",
            status == 200 and res["membership_expiry"][:7] == want.strftime("%Y-%m"),
            res.get("membership_expiry") if status == 200 else res,
        )
        check(
            "…measured from today, not from the old expiry",
            status == 200 and res.get("renewed_from") == today.isoformat(),
            res.get("renewed_from") if status == 200 else None,
        )

        # A member renewing early keeps what they have paid for.
        call(
            "/api/customers/bulk",
            "PATCH",
            {"ids": [made[1]], "fields": {"membership_expiry": "2027-03-31"}},
            token,
        )
        status, res = call(
            "/api/loyalty/renew", "POST", {"office": office, "customer_id": made[1]}
        )
        check(
            "renewing early extends rather than shortening",
            status == 200 and res["membership_expiry"] > "2027-03-31",
            res.get("membership_expiry") if status == 200 else res,
        )
        check(
            "…and says it measured from the old expiry",
            status == 200 and res.get("renewed_from") == "2027-03-31",
            res.get("renewed_from") if status == 200 else None,
        )

        status, res = call(
            "/api/loyalty/renew",
            "POST",
            {"office": office, "customer_id": "00000000-0000-0000-0000-000000000000"},
        )
        check("an unknown member is a 404", status == 404, status)

        # ---- The settings refuse nonsense -----------------------------------
        status, res = call(
            "/api/loyalty", "PUT", {"membership_term_months": 0}, token
        )
        check("a zero-month term is refused", status == 400, res)
        status, res = call(
            "/api/loyalty", "PUT", {"membership_fee_minor": -500}, token
        )
        check("a negative fee is refused", status == 400, res)

        # ---- Mix & Match products, through the API --------------------------
        status, deals = call("/api/mix-match", token=token)
        check("the deals list carries a product count",
              bool(deals) and "product_count" in deals[0], deals[0] if deals else None)

    finally:
        for cid in made:
            call(f"/api/customers/{cid}", "DELETE", token=token)
        status, rows = call("/api/customers", token=token)
        left = [r for r in rows if r["name"].startswith(MARK)]
        print(f"\nscratch customers left behind: {len(left)}")
        if left:
            FAIL.append("teardown left rows behind")

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        for f in FAIL:
            print("  FAILED:", f)
        sys.exit(1)


if __name__ == "__main__":
    main()
