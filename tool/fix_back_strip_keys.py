"""Find, and fix, till pages that have no key back to the home screen.

    python tool/fix_back_strip_keys.py                      # report only
    python tool/fix_back_strip_keys.py --apply SCREEN_ID    # fix one page

Those are the pages where the till draws its own "Back to <home>" strip
(EPOS 1.14.1, ScreenSet.reachesHome). The report lists each one, per venue,
with the keys already on it and the fix it would make: the page laid out most
like it (the same rail of page keys) is found, and the cell where that page
keeps its key home (LUNCH's DRINKS key at the foot of the food rail) becomes a
page key to home on this page too, with the same label and colours.

--apply changes that one cell on that one page and prints the row it replaced,
so it can be put back by hand. Nothing else is written. Tills pick the change
up the next time they load their screens (restart the till app to see it now).

Runs over SSH like deploy_memberships.py, against the back office database.
"""
import json
import sys
from collections import Counter

import deploy_memberships as dm

SQL_DUMP = r"""
SELECT JSON_OBJECT(
  'settings', (SELECT JSON_ARRAYAGG(JSON_OBJECT('office', office, 'home', home_screen_id,
                 'top', top_bar_screen_id, 'bottom', bottom_bar_screen_id))
               FROM epos_till_settings WHERE home_screen_id IS NOT NULL),
  'screens', (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', id, 'office', office, 'name', name,
                 'surface', surface, 'top', top_bar_id, 'bottom', bottom_bar_id))
              FROM epos_screens),
  'buttons', (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', b.id, 'screen', b.screen_id,
                 'row', b.grid_row, 'col', b.grid_col, 'kind', b.kind,
                 'target', b.target_screen_id, 'label', b.label, 'fill', b.fill, 'ink', b.ink))
              FROM epos_screen_buttons b
              JOIN epos_till_settings t ON t.office = b.office AND t.home_screen_id IS NOT NULL)
)
"""


def mariadb(sql):
    # Base64 so no quote in the SQL has to survive two shells.
    import base64
    b64 = base64.b64encode(sql.encode()).decode()
    return dm.ssh("run",
                  f"cd {dm.BACKOFFICE} && echo {b64} | base64 -d | "
                  "mariadb -N -B --raw $(grep -E '^DB_NAME=' .env | cut -d= -f2)")


def load():
    out = mariadb(SQL_DUMP).strip().splitlines()[-1]
    data = json.loads(out)
    return data["settings"] or [], data["screens"] or [], data["buttons"] or []


def stranded(settings, screens, buttons):
    """Yield (venue settings, page, proposal) for every page with no key home."""
    by_id = {s["id"]: s for s in screens}
    keys = {}
    for b in buttons:
        keys.setdefault(b["screen"], []).append(b)

    def bar(sid, surface):
        s = by_id.get(sid)
        return s if s and s["surface"] == surface else None

    def leads_home(s, home):
        return s is not None and any(
            b["kind"] == "page" and b["target"] == home for b in keys.get(s["id"], []))

    def twin(page, pages, home):
        # The page laid out most like this one (the same rail of page keys),
        # and the key home it has. BREAKFAST copies LUNCH's DRINKS key, not
        # the DRAUGHTS key the drinks pages carry where BREAKFAST has its own.
        mine = {(b["row"], b["col"]): (b["kind"], b["target"]) for b in keys.get(page["id"], [])}
        best, score = None, 0
        for other in pages:
            if other["id"] in (page["id"], home):
                continue
            theirs = keys.get(other["id"], [])
            homes = [b for b in theirs if b["kind"] == "page" and b["target"] == home]
            if not homes:
                continue
            same = sum(1 for b in theirs
                       if b["kind"] == "page" and mine.get((b["row"], b["col"])) == (b["kind"], b["target"]))
            if same > score:
                h = homes[0]
                best, score = (h["row"], h["col"], h["label"], h["fill"], h["ink"]), same
        return best

    for t in settings:
        home = t["home"]
        pages = [s for s in screens if s["office"] == t["office"] and s["surface"] == "sale"]
        # The venue's own habit: where its other pages put their key home.
        habit = Counter(
            (b["row"], b["col"], b["label"], b["fill"], b["ink"])
            for s in pages for b in keys.get(s["id"], [])
            if b["kind"] == "page" and b["target"] == home)
        for s in pages:
            if s["id"] == home:
                continue
            top = bar(s["top"], "topbar") or bar(t["top"], "topbar")
            bottom = bar(s["bottom"], "bottombar") or bar(t["bottom"], "bottombar")
            if any(leads_home(x, home) for x in (s, top, bottom)):
                continue
            proposal = twin(s, pages, home) or (habit.most_common(1)[0][0] if habit else None)
            yield t, s, proposal, keys.get(s["id"], [])


def report():
    settings, screens, buttons = load()
    names = {s["id"]: s["name"] for s in screens}
    found = False
    for t, s, proposal, own in stranded(settings, screens, buttons):
        found = True
        print(f"\n{t['office']}: page {s['name']!r} (screen {s['id']}) has no key to "
              f"{names.get(t['home'], t['home'])!r}")
        for b in sorted(own, key=lambda b: (b["row"], b["col"])):
            if b["kind"] == "page":
                print(f"   page key r{b['row']}c{b['col']} {b['label'] or ''!r} -> {names.get(b['target'], b['target'])!r}")
        if proposal:
            row, col, label, fill, ink = proposal
            here = next((b for b in own if b["row"] == row and b["col"] == col), None)
            now = f"{here['kind']} {here['label'] or ''!r}" if here else "an empty cell"
            shown = label or names.get(t["home"], "home")
            print(f"   fix: r{row}c{col} ({now}) becomes a key to home, shown as {shown!r}")
        else:
            print("   no other page has a key home to copy; add one in Screen Programming")
    if not found:
        print("Every page has a key back to its home screen. No till shows the Back strip.")


def apply(screen_id):
    settings, screens, buttons = load()
    for t, s, proposal, own in stranded(settings, screens, buttons):
        if s["id"] != screen_id:
            continue
        if not proposal:
            raise SystemExit("No other page has a key home to copy. Add one in Screen Programming.")
        row, col, label, fill, ink = proposal
        here = next((b for b in own if b["row"] == row and b["col"] == col), None)
        print("replacing:", json.dumps(here) if here else "empty cell")

        def q(v):
            return "NULL" if v is None else "'" + str(v).replace("\\", "\\\\").replace("'", "''") + "'"

        if here:
            sql = (f"UPDATE epos_screen_buttons SET kind='page', target_screen_id={t['home']}, plu_id=NULL, "
                   f"function_key=NULL, emoji=NULL, image_url=NULL, label={q(label)}, fill={q(fill)}, ink={q(ink)} WHERE id={here['id']}")
        else:
            sql = (f"INSERT INTO epos_screen_buttons (screen_id, office, grid_row, grid_col, kind, "
                   f"target_screen_id, label, fill, ink) VALUES ({s['id']}, {q(t['office'])}, {row}, {col}, "
                   f"'page', {t['home']}, {q(label)}, {q(fill)}, {q(ink)})")
        mariadb(sql + "; UPDATE epos_screens SET updated_at = NOW() WHERE id = " + str(s["id"]))
        print(f"done: {s['name']!r} r{row}c{col} is now {label!r} -> home")
        return
    raise SystemExit(f"Screen {screen_id} is not a page without a key home (run without --apply to list them).")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--apply":
        apply(int(sys.argv[2]))
    elif len(sys.argv) == 1:
        report()
    else:
        print(__doc__)
        sys.exit(2)
