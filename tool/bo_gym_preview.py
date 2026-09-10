"""Photograph the back office's Gym page, driving the real code, with no login.

    python tool/bo_gym_preview.py [width]

WHY THIS DOES NOT SIGN IN

Because it does not need to, and not needing to is worth something. What is
being checked here is the *page* -- does loadGym draw the board, do the colours
mean what they are supposed to mean, does the hours chart survive twenty-four
bars on a laptop -- and every one of those questions is about JavaScript and CSS
that this file can exercise directly.

So the real index.html, the real app.js and the real style.css are loaded from
the live server, a session is planted in localStorage so the shell boots, and
every /api/ call is intercepted and answered with invented data. Nothing signs
in, no credential is read from anywhere, and no request reaches the venue's
database.

WHAT IT THEREFORE DOES NOT PROVE

That the routes work. Those are proved by vesopa_server/test/gym.test.js against
a fake pool and by vesopa_server/tool/verify-gym-live.js against the live one.
This is the third leg: that what comes back is drawn properly. All three are
needed and none of them substitutes for another -- a green route and a blank
page is a fault a venue still reports.
"""

import json
import os
import pathlib
import sys
from datetime import datetime, timedelta

from playwright.sync_api import sync_playwright

BASE = os.environ.get("VESOPA_BO_BASE", "https://backoffice.vesopaepos.com")
OUT = pathlib.Path(
    os.environ.get(
        "VESOPA_SHOT_DIR",
        r"C:\Users\Administrator\Documents\Vesopa-Claude-Images\2026-09-10-gym",
    )
)


def clock(minutes_ago):
    return (datetime.now() - timedelta(minutes=minutes_ago)).isoformat(
        sep=" ", timespec="seconds"
    )


def day(days_from_now):
    return (datetime.now() + timedelta(days=days_from_now)).strftime("%Y-%m-%d")


def visit(vid, name, number, in_minutes, out_minutes=None, expired=False, closed=None):
    return {
        "id": vid,
        "customer_id": f"cust-{vid}",
        "member_no": number,
        "member_name": name,
        "card_number": f"9771{number:05d}",
        "entered_at": clock(in_minutes),
        "left_at": None if out_minutes is None else clock(out_minutes),
        "closed_by": closed,
        "expired": 1 if expired else 0,
        "membership_expiry": day(-4) if expired else day(120),
        "in_now": 1 if out_minutes is None else 0,
        "minutes": in_minutes - (out_minutes or 0),
    }


BOARD = [
    visit(1, "Sarah Hughes", 12, 47),
    visit(2, "Dafydd Morgan", 3, 26),
    visit(3, "Angela Protheroe", 41, 18),
    visit(4, "Ieuan Rees", 7, 95, expired=True),
    visit(5, "Kelly Bowen", 22, 210, 96, closed="card"),
    visit(6, "Rhys Llewellyn", 31, 250, 130, closed="card"),
    visit(7, "Marie Thomas", 8, 320, 80, closed="auto"),
]

ATTENDANCE = {
    "from": day(-29),
    "to": day(0),
    "days": 30,
    "members": [
        {
            "customer_id": f"c{i}",
            "member_name": name,
            "member_no": no,
            "card_number": f"9771{no:05d}",
            "visits": visits,
            "per_week": round(visits / (30 / 7), 1),
            "days_attended": min(visits, 26),
            "avg_minutes": avg,
            "first_visit": clock(29 * 1440),
            "last_visit": clock(last),
            "expired_visits": 0,
            "membership_expiry": expiry,
        }
        for i, (name, no, visits, avg, last, expiry) in enumerate(
            [
                ("Dafydd Morgan", 3, 24, 71, 26, day(210)),
                ("Sarah Hughes", 12, 19, 58, 47, day(88)),
                ("Angela Protheroe", 41, 17, 44, 18, day(12)),
                ("Kelly Bowen", 22, 11, 63, 96, day(300)),
                ("Ieuan Rees", 7, 6, None, 95, day(-4)),
                ("Marie Thomas", 8, 3, 39, 320, day(41)),
            ]
        )
    ],
    "by_hour": [
        {"hour": h, "visits": v}
        for h, v in [
            (6, 14), (7, 31), (8, 22), (9, 11), (10, 8), (11, 6), (12, 13),
            (13, 9), (14, 7), (15, 10), (16, 18), (17, 34), (18, 41),
            (19, 28), (20, 12), (21, 4),
        ]
    ],
    "by_day": [],
}

EXPIRIES = {
    "soon_days": 14,
    "grace_days": 0,
    "expired": [
        {
            "id": "c5",
            "name": "Ieuan Rees",
            "member_no": 7,
            "card_number": "977100007",
            "phone": "07700 900014",
            "email": None,
            "membership_expiry": day(-4),
            "days": -4,
            "last_visit": clock(95),
            "visits_90d": 6,
        },
        {
            "id": "c9",
            "name": "Gwen Edwards",
            "member_no": 55,
            "card_number": "977100055",
            "phone": None,
            "email": "gwen@example.com",
            "membership_expiry": day(-61),
            "days": -61,
            "last_visit": clock(62 * 1440),
            "visits_90d": 1,
        },
    ],
    "soon": [
        {
            "id": "c3",
            "name": "Angela Protheroe",
            "member_no": 41,
            "card_number": "977100041",
            "phone": "07700 900041",
            "email": None,
            "membership_expiry": day(12),
            "days": 12,
            "last_visit": clock(18),
            "visits_90d": 17,
        }
    ],
}

SETTINGS = {
    "office": "manager@vesopa.co.uk",
    "enabled": 1,
    "gym_prefix": "9771",
    "auto_close_hours": 4,
    "debounce_seconds": 45,
    "grace_days": 0,
    "expiry_slip": 1,
    "refuse_expired": 0,
    "expiring_soon_days": 14,
    "greeting_seconds": 6,
    "show_photo": 1,
}


def answer(route, payload):
    route.fulfill(
        status=200,
        content_type="application/json",
        body=json.dumps(payload),
    )


def main():
    width = int(sys.argv[1]) if len(sys.argv) > 1 else 1440
    OUT.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as play:
        browser = play.chromium.launch()
        page = browser.new_page(viewport={"width": width, "height": 1000})

        def api(route):
            path = route.request.url.split("/api", 1)[1].split("?")[0]
            if path == "/gym/settings":
                return answer(route, SETTINGS)
            if path == "/gym/board":
                return answer(route, BOARD)
            if path == "/gym/attendance":
                return answer(route, ATTENDANCE)
            if path == "/gym/expiries":
                return answer(route, EXPIRIES)
            if path == "/me/access":
                return answer(route, {"unrestricted": True, "role": "", "permissions": []})
            # Everything else the shell asks for on the way past.
            return answer(route, [])

        page.route("**/api/**", api)
        # The socket would sit there retrying against a server that has no idea
        # who this is; there is nothing to push to a page nobody is signed in to.
        page.route("**/socket**", lambda route: route.abort())

        page.add_init_script(
            """
            localStorage.setItem('vesopa_token', 'preview');
            localStorage.setItem('vesopa_user', JSON.stringify({
              name: 'Preview', role: 'manager', officeName: 'The Vesopa Kitchen',
              email: 'manager@vesopa.co.uk'
            }));
            """
        )

        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_timeout(2500)

        shots = []
        for tab, name in [
            ("board", "who-is-in"),
            ("attendance", "how-often"),
            ("expiries", "expiries"),
            ("settings", "settings"),
        ]:
            page.evaluate("() => show('gym', { push: false })")
            page.wait_for_timeout(900)
            page.click(f'[data-gymtab="{tab}"]')
            page.wait_for_timeout(1200)
            path = OUT / f"gym-{name}-{width}.png"
            page.screenshot(path=str(path), full_page=True)
            shots.append(path)
            print(f"  {path}")

        # And the rail, to prove the Gym entry only appears where there is one.
        rail = page.evaluate(
            "() => [...document.querySelectorAll('.nav[data-view]')]"
            ".filter(b => !b.hidden).map(b => b.dataset.view)"
        )
        print(f"\n  rail carries Gym: {'gym' in rail}")

        browser.close()


if __name__ == "__main__":
    main()
