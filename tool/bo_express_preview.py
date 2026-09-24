"""Photograph the back office's Vesopa Express page, driving the real code, with no login.

    python tool/bo_express_preview.py [width]

The same arrangement as bo_gym_preview.py, and for the same reasons: the real
index.html, app.js and style.css are loaded from the live server, a session is
planted in localStorage so the shell boots, and every /api/ call is answered
with invented data. Nothing signs in, no credential is read, and no request
reaches a venue's data.

What it proves is the third leg -- that the page draws what the routes return,
on and off. The routes themselves are proved by
vesopa_server/test/express.test.js (a real database) and by
vesopa_server/tool/verify-express-live.js (the live one).
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
        r"C:\Users\Administrator\Documents\Vesopa-Claude-Images\2026-09-10-vesopa-express\backoffice",
    )
)


def at(minutes_ago):
    return (datetime.now() - timedelta(minutes=minutes_ago)).isoformat(timespec="seconds")


SETTINGS_ON = {
    "enabled": 1, "eat_in": 1, "take_away": 1, "pay_card": 1, "pay_counter": 1,
    "demo_mode": 0, "ask_name": 0, "idle_seconds": 60, "number_start": 1, "number_end": 999,
    "welcome_title": "Order here, skip the queue", "welcome_subtitle": None,
    "welcome_image_url": None, "upsell_items": [12], "notify_till": 1, "notify_kitchen": 1,
    "board_enabled": 1, "passcode_set": True, "dojo_key_source": "platform",
    "dojo_key_hint": None, "dojo_sandbox": True, "can_store_key": True,
    "board_url": BASE + "/express/board/" + "3f9c" * 8, "vesopa_sign_in": True,
}
SETTINGS_OFF = {**SETTINGS_ON, "enabled": 0, "passcode_set": False, "board_url": None}


def order(oid, number, status, total, minutes, kind="take_away", payment="card", name=None, note=None, items=2):
    return {
        "id": oid, "public_id": f"p{oid}", "number": number, "status": status, "status_note": note,
        "order_type": kind, "payment": payment, "customer_name": name, "total_minor": total,
        "sale_id": None, "ticket_id": None, "created_at": at(minutes), "paid_at": at(minutes - 1),
        "ready_at": None, "collected_at": None, "kiosk_name": "Kiosk by the door", "items": items,
    }


ORDERS = {
    "date": datetime.now().strftime("%Y-%m-%d"),
    "orders": [
        order(9, 47, "awaiting_payment", 1395, 1),
        order(8, 46, "paid", 2240, 4, "eat_in", name="Rhys", items=3),
        order(7, 45, "paid", 845, 7),
        order(6, 44, "ready", 3190, 11, "eat_in", items=4),
        order(5, 43, "counter", 1250, 16, payment="counter"),
        order(4, 42, "collected", 1840, 22, items=3),
        order(3, 41, "failed", 995, 31, note="The card was declined."),
        order(2, 40, "collected", 2735, 38, "eat_in", name="Ffion", items=5),
    ],
}

KIOSKS = [
    {"id": "k1", "name": "Kiosk by the door", "dojo_terminal_id": "tm_sandbox_1",
     "commissioned_by": "manager@vesopa.co.uk", "commissioned_at": at(600),
     "last_seen_at": at(0), "app_version": "1.0.0+1", "screen": "1080x1920", "revoked_at": None},
    {"id": "k2", "name": "Kiosk by the bar", "dojo_terminal_id": None,
     "commissioned_by": "manager@vesopa.co.uk", "commissioned_at": at(300),
     "last_seen_at": at(2), "app_version": "1.0.0+1", "screen": "1920x1080", "revoked_at": None},
    {"id": "k3", "name": "Old kiosk", "dojo_terminal_id": None,
     "commissioned_by": "manager@vesopa.co.uk", "commissioned_at": at(9000),
     "last_seen_at": at(8000), "app_version": "1.0.0+1", "screen": None, "revoked_at": at(7000)},
]

TERMINALS = {"sandbox": True, "terminals": [
    {"id": "tm_sandbox_1", "tid": "VCMVESOSIP0", "status": "Available"},
    {"id": "tm_sandbox_2", "tid": "VCMVESOSIP1", "status": "Available"},
]}

MENU = [
    {"id": 1, "name": "Burgers", "items": [
        {"id": 10, "name": "The Bridge Cheeseburger"}, {"id": 11, "name": "Buttermilk Chicken"},
        {"id": 12, "name": "Onion Rings"}]},
    {"id": 2, "name": "Drinks", "items": [
        {"id": 20, "name": "Salted Caramel Shake"}, {"id": 21, "name": "Coca-Cola 330ml"}]},
]


def main():
    width = int(sys.argv[1]) if len(sys.argv) > 1 else 1440
    OUT.mkdir(parents=True, exist_ok=True)
    state = {"settings": SETTINGS_ON}

    with sync_playwright() as play:
        browser = play.chromium.launch()
        page = browser.new_page(viewport={"width": width, "height": 1000})

        def answer(route, payload):
            route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))

        def api(route):
            path = route.request.url.split("/api", 1)[1].split("?")[0]
            if path == "/express/settings":
                return answer(route, state["settings"])
            if path == "/express/orders":
                return answer(route, ORDERS if state["settings"]["enabled"] else {"date": ORDERS["date"], "orders": []})
            if path == "/express/kiosks":
                return answer(route, KIOSKS)
            if path == "/express/terminals":
                return answer(route, TERMINALS)
            if path == "/dinein/menu":
                return answer(route, MENU)
            if path == "/me/access":
                return answer(route, {"unrestricted": True, "role": "", "permissions": []})
            return answer(route, [])

        page.route("**/api/**", api)
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

        rail = page.evaluate(
            "() => [...document.querySelectorAll('.nav[data-view]')].map(b => b.dataset.view)"
        )
        print(f"  rail carries Vesopa Express: {'express' in rail}")

        for settings, label in [(SETTINGS_OFF, "off"), (SETTINGS_ON, "on")]:
            state["settings"] = settings
            for tab in ["orders", "kiosks", "settings"]:
                page.evaluate("() => show('express', { push: false })")
                page.wait_for_timeout(900)
                page.click(f'[data-exptab="{tab}"]')
                page.wait_for_timeout(1200)
                path = OUT / f"express-{label}-{tab}-{width}.png"
                page.screenshot(path=str(path), full_page=True)
                print(f"  {path}")
            print("  url:", page.url)

        browser.close()


if __name__ == "__main__":
    main()
