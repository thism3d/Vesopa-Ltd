"""Buy, spend and refund a gift voucher on the LIVE shop, then put everything back.

    python vesopa_gift/scripts/verify-live.py              the whole check, cleaned up
    python vesopa_gift/scripts/verify-live.py --pay <id>   pay an order already waiting
                                                           (its public id) instead of
                                                           buying a new one
    python vesopa_gift/scripts/verify-live.py --keep       leave what it made, to look at

WHY THIS EXISTS WHEN THERE IS ALREADY test/e2e.test.js

That one runs against scratch databases and a pretend Dojo, on random ports. It
proved every decision and missed the fault that stopped the live service dead:
the back office's port, 5060, is one fetch() refuses. Only the real thing shows
whether nginx, the certificate, Dojo's sandbox, the live EPOS and the mail
server all do what the tests assume.

THE PLAN'S CHECK (PLAN.md, "How it is tested"): buy a voucher on the real shop
with a Dojo sandbox card, receive it at manager@vesopa.co.uk, spend part of it
at the till, check the balance page and the venue's console, refund the rest.

SAFETY
  * The test venue only (office 9, manager@vesopa.co.uk), which pays with the
    platform's SANDBOX Dojo key. Before typing a card it checks the checkout is a
    sandbox one (pi_sandbox_...) and stops otherwise. The card is Dojo's own
    published sandbox card, which only exists in the sandbox.
  * It deletes only rows it CREATED, by the ids it recorded, and checks with SQL
    that they are gone. The till is spent from with a token minted from the back
    office's own config, as verify-express-live.js does.
  * The console is reached as manager@vesopa.co.uk with a fifteen-minute session
    minted on the Auth server (vesopa_auth/scripts/console-session.js) -- the
    live sign-in form is never driven, because that mails a real code. The
    session is revoked afterwards.
  * It never prints a secret.
  * Real email goes to manager@vesopa.co.uk: the voucher, the receipt and the
    venue's sale note. That is the point of it.

Screenshots: Documents\\Vesopa-Claude-Images\\<date>-gift-live, never deleted.
"""
import datetime
import json
import os
import pathlib
import re
import sys
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / ".claude" / "skills" / "vesopa-ops" / "scripts"))
import paramiko  # noqa: E402
import vesopa_ssh  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SHOP = "https://gift.vesopaepos.com"
SLUG = "vesopa-kitchen"
OFFICE_ID = 9
OFFICE = "manager@vesopa.co.uk"
GIFT_APP = "/home/vesopa/web/gift.vesopaepos.com/private/nodeapp"
AUTH_HOST = "34.63.118.67"
AUTH_APP = "/home/vesopasoftware/web/auth.vesopa.com/private/nodeapp"
# Dojo's published sandbox card: no 3-D Secure, always approved. Sandbox only.
SANDBOX_CARD = {"name": "Test Cardholder", "number": "5200000000001005", "expiry": "1229", "cvc": "020"}
SPEND = 750
OUT = pathlib.Path(rf"C:\Users\Administrator\Documents\Vesopa-Claude-Images\{datetime.date.today()}-gift-live")

passed, failures = 0, []


def check(name, fn):
    global passed
    try:
        fn()
        passed += 1
        print(f"  ok  {name}", flush=True)
    except Exception as e:  # noqa: BLE001 -- a check reports, it does not stop the run
        failures.append(f"{name}: {e}")
        print(f"  FAIL  {name}\n        {e}", flush=True)


def need(cond, message):
    if not cond:
        raise AssertionError(message)


# ---- The servers ---------------------------------------------------------------

def connect(host=None):
    cfg = vesopa_ssh.settings()
    user, _, h = cfg["VESOPA_SSH_HOST"].partition("@")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host or h, username=user or "root", password=cfg["VESOPA_SSH_PASSWORD"],
              timeout=30, banner_timeout=30, auth_timeout=30, look_for_keys=False, allow_agent=False)
    return c


def remote(client, command, stdin_text=None):
    """Run a command; anything sensitive travels on stdin, never in the command line."""
    i, o, e = client.exec_command(command, timeout=180)
    if stdin_text is not None:
        i.write(stdin_text)
    i.channel.shutdown_write()
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    if o.channel.recv_exit_status() != 0:
        raise RuntimeError(f"remote command failed: {err.strip()[:400]}")
    return out


def sql(client, database, statement):
    """Rows as lists of strings. Root's socket login, so no password is handed about."""
    text = remote(client, f"mysql -N -B {database}", statement)
    return [line.split("\t") for line in text.splitlines() if line.strip() and "Deprecated" not in line]


def gift_sql(client, statement):
    return sql(client, "vesopa_giftdb", statement)


def epos_sql(client, statement):
    return sql(client, "vesopa_eposdb", statement)


def quote(value):
    """For the few literals this puts in SQL: ids and codes it read back itself."""
    s = str(value)
    if not re.fullmatch(r"[A-Za-z0-9_@.\-]{1,64}", s):
        raise ValueError("refusing to put an unexpected value into SQL")
    return f"'{s}'"


# ---- The browser ---------------------------------------------------------------

def shot(page, name):
    OUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)


def decline_optional_cookies(page):
    """Dojo's cookie notice covers the Pay button. Never 'Accept': open the
    choices, switch off anything optional, and save only what is necessary."""
    manage = page.get_by_role("button", name=re.compile(r"^\s*manage cookies\s*$", re.I))
    if not manage.count():
        return
    manage.first.click()
    page.wait_for_timeout(1000)
    shot(page, "03b-dojo-cookie-choices-390")
    reject = page.get_by_role("button", name=re.compile(r"reject all|decline all|only necessary|necessary only", re.I))
    if reject.count():
        reject.first.click()
        page.wait_for_timeout(800)
        return
    # Dojo offers only "Accept all" and "Save preferences", with Analytics and
    # Marketing switched ON. Its switches are plain <div title="on|off">, not
    # inputs, so they are turned off by title -- and proven off before saving.
    switches = page.locator("#modal-root div[title='on']")
    for _ in range(switches.count()):
        switches.first.click()
        page.wait_for_timeout(300)
    still_on = page.locator("#modal-root div[title='on']").count()
    need(still_on == 0, f"{still_on} optional cookie switch(es) would not turn off -- not saving")
    need(page.locator("#modal-root div[title='off']").count() >= 1, "the cookie switches were not found")
    shot(page, "03c-dojo-cookies-declined-390")
    page.get_by_role("button", name=re.compile(r"^\s*save preferences\s*$", re.I)).first.click()
    page.wait_for_timeout(800)


def pay_on_dojo(page):
    page.wait_for_url(re.compile(r"https://pay\.dojo\.tech/checkout/"), timeout=45000)
    intent = page.url.split("/checkout/")[1].split("?")[0]
    if not intent.startswith("pi_sandbox_"):
        raise SystemExit(f"STOPPED: the checkout is not a sandbox one ({intent[:12]}...). No card was typed.")
    page.wait_for_timeout(3500)
    shot(page, "03-dojo-checkout-390")
    decline_optional_cookies(page)
    frame = None
    for _ in range(30):
        frame = next((f for f in page.frames if "connect.paymentsense.cloud" in f.url), None)
        if frame and frame.locator("#cardNumber").count():
            break
        page.wait_for_timeout(500)
    need(frame is not None, "Dojo's card form did not appear")
    frame.locator("#cardName").fill(SANDBOX_CARD["name"])
    frame.locator("#cardNumber").press_sequentially(SANDBOX_CARD["number"], delay=30)
    frame.locator("#expiryDate").press_sequentially(SANDBOX_CARD["expiry"], delay=30)
    frame.locator("#cv2").press_sequentially(SANDBOX_CARD["cvc"], delay=30)
    shot(page, "04-dojo-filled-390")
    page.locator("#payButton").click()
    return intent


def main():
    keep = "--keep" in sys.argv
    pay_existing = sys.argv[sys.argv.index("--pay") + 1] if "--pay" in sys.argv else None
    started = time.time()
    epos_box = connect()
    made = {"orders": [], "cards": [], "sessions_after": None, "audit_after": None}

    # ---- Before -------------------------------------------------------------
    venue = gift_sql(epos_box, f"SELECT enabled, slug, IFNULL(notify_email, '') FROM gift_venues WHERE office_id = {OFFICE_ID}")
    if not venue or venue[0][0] != "1" or venue[0][1] != SLUG:
        raise SystemExit("the test venue's shop is not switched on at /vesopa-kitchen")
    notify_before = venue[0][2]
    made["audit_after"] = int(gift_sql(epos_box, "SELECT IFNULL(MAX(id), 0) FROM gift_audit")[0][0])
    made["sessions_after"] = gift_sql(epos_box, "SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s')")[0][0]
    if pay_existing:
        row = gift_sql(epos_box, f"SELECT id, status FROM gift_orders WHERE public_id = {quote(pay_existing)} AND office_id = {OFFICE_ID}")
        if not row or row[0][1] != "pending":
            raise SystemExit("that order is not waiting to be paid on the test venue")
        made["orders"].append(int(row[0][0]))
    orders_before = int(gift_sql(epos_box, "SELECT IFNULL(MAX(id), 0) FROM gift_orders")[0][0])

    state = {}
    with sync_playwright() as play:
        browser = play.chromium.launch()
        phone = browser.new_context(viewport={"width": 390, "height": 844}, locale="en-GB", timezone_id="Europe/London")
        page = phone.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "gift.vesopaepos.com" in (m.location or {}).get("url", "") else None)

        # ---- Buy and pay ----------------------------------------------------------
        def buy():
            page.goto(f"{SHOP}/{SLUG}", wait_until="load")
            shot(page, "01-shop-home-390")
            need("Buy a gift voucher" in page.content(), "the shop has no buy button")
            if pay_existing:
                page.goto(f"{SHOP}/{SLUG}/pay/{pay_existing}", wait_until="load")
            else:
                page.goto(f"{SHOP}/{SLUG}/buy", wait_until="load")
                page.check('input[name="amount"][value="2500"]', force=True)
                page.check('input[name="send_to"][value="buyer"]', force=True)
                page.fill('input[name="buyer_name"]', "Vesopa Live Check")
                page.fill('input[name="buyer_email"]', OFFICE)
                shot(page, "02-buy-filled-390")
                page.click('button[type="submit"]')
            state["intent"] = pay_on_dojo(page)
            page.wait_for_url(re.compile(rf"{re.escape(SHOP)}/{SLUG}/paid/"), timeout=90000)
            page.wait_for_selector("text=Paid.", timeout=90000)
            shot(page, "05-paid-390")
            state["public"] = page.url.rstrip("/").split("/paid/")[1].split("?")[0]
        check("a £25 voucher is bought on the live shop and paid on Dojo's sandbox", buy)

        if "public" in state:
            row = gift_sql(epos_box, f"SELECT id FROM gift_orders WHERE public_id = {quote(state['public'])}")
            if row and int(row[0][0]) not in made["orders"]:
                made["orders"].append(int(row[0][0]))
        for (oid,) in gift_sql(epos_box, f"SELECT id FROM gift_orders WHERE id > {orders_before} AND office_id = {OFFICE_ID} AND buyer_email = {quote(OFFICE)}"):
            if int(oid) not in made["orders"]:
                made["orders"].append(int(oid))

        def paid_and_issued():
            need(made["orders"], "no order was made")
            oid = made["orders"][0]
            o = gift_sql(epos_box, f"SELECT status, sandbox, card_last4, IF(receipt_sent_at IS NULL, 0, 1), IF(venue_told_at IS NULL, 0, 1) FROM gift_orders WHERE id = {oid}")[0]
            need(o[0] == "paid" and o[1] == "1", f"order is {o[0]}, sandbox={o[1]}")
            line = gift_sql(epos_box, f"SELECT id, card_id, card_code, view_token, IF(delivered_at IS NULL, 0, 1) FROM gift_order_lines WHERE order_id = {oid}")[0]
            need(line[1] and line[1] != "NULL", "no card was issued")
            state.update(line_id=int(line[0]), card_id=line[1], code=line[2], token=line[3])
            made["cards"].append(line[1])
            card = epos_sql(epos_box, f"SELECT office, source, balance_minor, status, external_ref FROM epos_gift_cards WHERE id = {quote(line[1])}")
            need(card, "the card is not in the live EPOS")
            need(card[0][0] == OFFICE and card[0][1] == "gift" and card[0][2] == "2500" and card[0][3] == "active",
                 f"the card is wrong: {card[0][1:4]}")
            need(o[3] == "1" and o[4] == "1" and line[4] == "1", f"mail not all sent: receipt={o[3]} venue={o[4]} voucher={line[4]}")
        check("the order is paid, the card is in the live EPOS, and all three emails went", paid_and_issued)

        def voucher_page():
            page.goto(f"{SHOP}/v/{state['token']}", wait_until="load")
            shot(page, "06-voucher-page-390")
            need(state["code"] in page.content(), "the code is not on the voucher page")
            with urllib.request.urlopen(f"{SHOP}/v/{state['token']}/voucher.pdf", timeout=30) as r:
                body = r.read()
                need(r.headers.get("Content-Type", "").startswith("application/pdf") and len(body) > 10000, "the PDF did not come back")
                (OUT / "07-voucher.pdf").write_bytes(body)
        check("the voucher page shows the code, and its PDF downloads", voucher_page)

        def till_spend():
            script = """
require('dotenv').config({ quiet: true });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const tok = jwt.sign({ scope: 'terminal', office: %s, officeId: %d }, process.env.JWT_SECRET, { expiresIn: '5m' });
const call = (p, body) => fetch('https://backoffice.vesopaepos.com/api/gift-cards/' + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
(async () => {
  const h = await call('hold', { code: %s, amount_minor: %d, order_id: crypto.randomUUID(), terminal: 'Gift live check', clerk_name: 'Live check' });
  const c = h.body && h.body.hold_id ? await call('capture', { hold_id: h.body.hold_id }) : { status: 0, body: null };
  console.log(JSON.stringify({ hold: h.status, capture: c.status, balance: c.body && c.body.card && c.body.card.balance_minor, error: (h.body && h.body.error) || (c.body && c.body.error) || null }));
})();
""" % (json.dumps(OFFICE), OFFICE_ID, json.dumps(state["code"]), SPEND)
            out = remote(epos_box, f"cd {vesopa_ssh.settings()['VESOPA_REMOTE_APP']} && node -", script).strip().splitlines()[-1]
            r = json.loads(out)
            need(r["hold"] == 200 and r["capture"] == 200 and r["balance"] == 2500 - SPEND, f"the till said {r}")
        check(f"the till holds and spends £{SPEND / 100:.2f} of it", till_spend)

        def balance_page():
            page.goto(f"{SHOP}/{SLUG}/balance", wait_until="load")
            page.fill('input[name="code"]', state["code"])
            page.click('button[type="submit"]')
            page.wait_for_load_state("load")
            shot(page, "08-balance-390")
            need("£17.50" in page.content(), "the balance page does not say £17.50")
        check("the balance page says £17.50 is left", balance_page)

        # ---- The console, as the venue's manager -------------------------------------
        auth_box = connect(AUTH_HOST)
        try:
            token = remote(auth_box, f"cd {AUTH_APP} && node scripts/console-session.js {OFFICE}").strip().splitlines()[-1]
            desk = browser.new_context(viewport={"width": 1440, "height": 900}, locale="en-GB", timezone_id="Europe/London")
            desk.add_cookies([{"name": "__Host-vesopa_sid", "value": token, "url": "https://auth.vesopa.com/",
                               "secure": True, "httpOnly": True, "sameSite": "Lax"}])
            token = None
            admin = desk.new_page()
            admin.on("dialog", lambda d: d.accept())

            def console_signin():
                admin.goto(f"{SHOP}/admin/start", wait_until="load")
                admin.wait_for_url(re.compile(rf"{re.escape(SHOP)}/admin/v/{OFFICE_ID}"), timeout=45000)
                shot(admin, "09-console-dashboard-1440")
                need("Dashboard" in admin.content(), "the dashboard did not open")
            check("Continue with Vesopa lets the venue's manager into its console", console_signin)

            def refund():
                oid = made["orders"][0]
                admin.goto(f"{SHOP}/admin/v/{OFFICE_ID}/orders/{oid}", wait_until="load")
                shot(admin, "10-console-order-1440")
                admin.locator("form[action$='/refund'] button[type='submit']").first.click()
                admin.wait_for_load_state("load")
                admin.wait_for_timeout(1500)
                shot(admin, "11-console-refunded-1440")
                rf = gift_sql(epos_box, f"SELECT amount_minor, status FROM gift_refunds WHERE order_id = {oid}")
                need(rf and rf[0] == [str(2500 - SPEND), "done"], f"refund rows: {rf}")
                card = epos_sql(epos_box, f"SELECT status FROM epos_gift_cards WHERE id = {quote(state['card_id'])}")[0][0]
                need(card == "void", f"the card is {card}, not void")
                o = gift_sql(epos_box, f"SELECT refunded_minor FROM gift_orders WHERE id = {oid}")[0][0]
                need(o == str(2500 - SPEND), f"order refunded {o}")
            check("a refund from the console pays back only the £17.50 left, and voids the card", refund)
            desk.close()
        finally:
            # Revoke the minted session whatever happened: fifteen minutes is short,
            # but no session is shorter.
            if not keep:
                remote(auth_box, f"cd {AUTH_APP} && node -", """
const db = require('./src/db');
(async () => {
  const r = await db.execute("UPDATE sso_sessions s JOIN user_identities i ON i.user_id = s.user_id AND i.type = 'email' SET s.revoked_at = NOW() WHERE i.identifier_norm = ? AND s.ip = '127.0.0.1' AND s.user_agent = 'vesopa-console-session' AND s.revoked_at IS NULL", [%s]);
  console.log('revoked', (r && (r.affectedRows ?? (r[0] && r[0].affectedRows))) || 0);
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
""" % json.dumps(OFFICE))
            auth_box.close()

        for e in dict.fromkeys(errors):
            print(f"    ! browser error: {e}")
        browser.close()

    # ---- Put it back ---------------------------------------------------------------
    if keep:
        print(f"\nkept: orders {made['orders']}, cards {len(made['cards'])}")
    else:
        ids = ",".join(str(i) for i in made["orders"]) or "0"
        cards = ",".join(quote(c) for c in made["cards"]) or "''"
        epos_sql(epos_box, f"DELETE FROM epos_gift_card_holds WHERE gift_card_id IN ({cards}); "
                           f"DELETE FROM epos_gift_card_txns WHERE gift_card_id IN ({cards}); "
                           f"DELETE FROM epos_gift_cards WHERE id IN ({cards}) AND office = {quote(OFFICE)};")
        gift_sql(epos_box, f"DELETE FROM gift_refunds WHERE order_id IN ({ids}); "
                           f"DELETE FROM gift_order_lines WHERE order_id IN ({ids}); "
                           f"DELETE FROM gift_orders WHERE id IN ({ids}) AND office_id = {OFFICE_ID}; "
                           f"DELETE FROM gift_audit WHERE id > {made['audit_after']} AND (office_id = {OFFICE_ID} OR actor = {quote(OFFICE)}); "
                           f"DELETE FROM gift_sessions WHERE email = {quote(OFFICE)} AND created_at >= '{made['sessions_after']}'; "
                           f"UPDATE gift_venues SET notify_email = {quote(notify_before) if notify_before else 'NULL'} WHERE office_id = {OFFICE_ID};")

        def gone():
            left_epos = epos_sql(epos_box, f"SELECT (SELECT COUNT(*) FROM epos_gift_cards WHERE id IN ({cards})) + "
                                           f"(SELECT COUNT(*) FROM epos_gift_card_txns WHERE gift_card_id IN ({cards})) + "
                                           f"(SELECT COUNT(*) FROM epos_gift_card_holds WHERE gift_card_id IN ({cards}))")[0][0]
            left_gift = gift_sql(epos_box, f"SELECT (SELECT COUNT(*) FROM gift_orders WHERE id IN ({ids})) + "
                                           f"(SELECT COUNT(*) FROM gift_order_lines WHERE order_id IN ({ids})) + "
                                           f"(SELECT COUNT(*) FROM gift_refunds WHERE order_id IN ({ids}))")[0][0]
            need(left_epos == "0" and left_gift == "0", f"rows left: epos {left_epos}, gift {left_gift}")
        check("everything it made is gone again (checked with SQL)", gone)

    epos_box.close()
    print(f"\n{passed} passed, {len(failures)} failed  ({time.time() - started:.0f}s)  evidence: {OUT}")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
