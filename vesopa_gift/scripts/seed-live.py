"""Ten days of sample trading on the LIVE test venue, so the console has something to show.

    python vesopa_gift/scripts/seed-live.py            # what it would do
    python vesopa_gift/scripts/seed-live.py --apply    # make it
    python vesopa_gift/scripts/seed-live.py --remove   # take it all out again

Test venue only (office 9, The Vesopa Kitchen). Puts scripts/seed-sample.js and
the event picture on the box, runs the seeder there -- real orders through the
real code, cards really issued in the live EPOS, marked paid by hand, no email --
then, with root on the box, moves the EPOS cards back to the days the orders were
placed and spends a few of them at a till (a token minted from the back office's
own config, as verify-live.py does), each spend moved back to its day.

Every seeded order carries intent_id 'seed-<n>'; --remove finds them by that,
and takes the EPOS cards, holds and movements out by id.
"""
import json
import os
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / ".claude" / "skills" / "vesopa-ops" / "scripts"))
import vesopa_ssh  # noqa: E402

OFFICE_ID = 9
OFFICE = "manager@vesopa.co.uk"
GIFT_APP = "/home/vesopa/web/gift.vesopaepos.com/private/nodeapp"
EVENT_IMAGE = "seedeventtasting01.jpg"


def remote(client, command, stdin_text=None):
    i, o, e = client.exec_command(command, timeout=300)
    if stdin_text is not None:
        i.write(stdin_text)
    i.channel.shutdown_write()
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    if o.channel.recv_exit_status() != 0:
        raise RuntimeError(f"remote command failed: {(err or out).strip()[:600]}")
    return out


def sql(client, database, statement):
    text = remote(client, f"mysql -N -B {database}", statement)
    return [line.split("\t") for line in text.splitlines() if line.strip() and "Deprecated" not in line]


def quote(value):
    s = str(value)
    if not re.fullmatch(r"[A-Za-z0-9_@.:\- ]{1,64}", s):
        raise ValueError(f"refusing to put {s!r} into SQL")
    return f"'{s}'"


def till_spend(client, code, minor):
    script = """
require('dotenv').config({ quiet: true });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const tok = jwt.sign({ scope: 'terminal', office: %s, officeId: %d }, process.env.JWT_SECRET, { expiresIn: '5m' });
const call = (p, body) => fetch('https://backoffice.vesopaepos.com/api/gift-cards/' + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
(async () => {
  const sale = crypto.randomUUID();
  const h = await call('hold', { code: %s, amount_minor: %d, order_id: sale, terminal: 'Bar', clerk_name: 'Sioned' });
  const c = h.body && h.body.hold_id ? await call('capture', { hold_id: h.body.hold_id, order_id: sale }) : { status: 0, body: null };
  console.log(JSON.stringify({ hold: h.status, capture: c.status, left: c.body && c.body.card && c.body.card.balance_minor,
    error: (h.body && h.body.error) || (c.body && c.body.error) || null }));
})();
""" % (json.dumps(OFFICE), OFFICE_ID, json.dumps(code), minor)
    out = remote(client, f"cd {vesopa_ssh.settings()['VESOPA_REMOTE_APP']} && node -", script).strip().splitlines()[-1]
    r = json.loads(out)
    if r["hold"] != 200 or r["capture"] != 200:
        raise RuntimeError(f"the till would not spend {minor} of {code}: {r}")
    return r["left"]


def main():
    apply = "--apply" in sys.argv
    removing = "--remove" in sys.argv
    client = vesopa_ssh.connect()
    try:
        if removing:
            if not apply:
                n = sql(client, "vesopa_giftdb", f"SELECT COUNT(*) FROM gift_orders WHERE office_id = {OFFICE_ID} AND intent_id LIKE 'seed-%'")[0][0]
                print(f"would remove {n} seeded orders and their EPOS cards. Re-run with --remove --apply.")
                return
            out = remote(client, f"cd {GIFT_APP} && node scripts/seed-sample.js --remove").strip().splitlines()[-1]
            r = json.loads(out)
            cards = ",".join(quote(c) for c in r["epos_card_ids"]) or "''"
            sql(client, "vesopa_eposdb", f"DELETE FROM epos_gift_card_holds WHERE gift_card_id IN ({cards}); "
                                         f"DELETE FROM epos_gift_card_txns WHERE gift_card_id IN ({cards}); "
                                         f"DELETE FROM epos_gift_cards WHERE id IN ({cards}) AND office = {quote(OFFICE)};")
            left = sql(client, "vesopa_eposdb", f"SELECT (SELECT COUNT(*) FROM epos_gift_cards WHERE id IN ({cards})) + "
                                                f"(SELECT COUNT(*) FROM epos_gift_card_txns WHERE gift_card_id IN ({cards}))")[0][0]
            remote(client, f"rm -f {GIFT_APP}/uploads/{OFFICE_ID}/{EVENT_IMAGE}")
            print(f"removed {r['removed']} orders, {r['events']} event, {len(r['epos_card_ids'])} EPOS cards; rows left in the EPOS: {left}")
            return

        sftp = client.open_sftp()
        try:
            sftp.put(str(HERE / "seed-sample.js"), f"{GIFT_APP}/scripts/seed-sample.js")
            remote(client, f"mkdir -p {GIFT_APP}/uploads/{OFFICE_ID}")
            sftp.put(str(HERE.parent / "design" / "event-tasting.jpg"), f"{GIFT_APP}/uploads/{OFFICE_ID}/{EVENT_IMAGE}")
            remote(client, f"chown -R vesopa:vesopa {GIFT_APP}/uploads {GIFT_APP}/scripts")
        finally:
            sftp.close()

        print(remote(client, f"cd {GIFT_APP} && node scripts/seed-sample.js").rstrip())
        if not apply:
            return

        out = remote(client, f"cd {GIFT_APP} && node scripts/seed-sample.js --apply").strip().splitlines()[-1]
        made = json.loads(out)
        print(f"made {made['made']} orders, event {made['event']}, {len(made['cards'])} cards")

        for c in made["cards"]:
            cid, placed = quote(c["card_id"]), quote(c["placed"])
            sql(client, "vesopa_eposdb", f"UPDATE epos_gift_cards SET created_at = {placed} WHERE id = {cid}; "
                                         f"UPDATE epos_gift_card_txns SET created_at = {placed} WHERE gift_card_id = {cid};")
            for sp in c["spends"]:
                left = till_spend(client, c["code"], sp["minor"])
                sql(client, "vesopa_eposdb", f"UPDATE epos_gift_card_txns SET created_at = {quote(sp['at'])} "
                                             f"WHERE gift_card_id = {cid} AND kind = 'redeem' AND created_at > {placed};")
                print(f"  {c['order']}: spent £{sp['minor'] / 100:.2f} on {sp['at'][:10]}, £{left / 100:.2f} left")
        print("done. Remove with: python vesopa_gift/scripts/seed-live.py --remove --apply")
    finally:
        client.close()


if __name__ == "__main__":
    main()
