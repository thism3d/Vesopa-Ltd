"""Pontardawe RFC's online menu (menu.vesopa.com/pontardawe-rfc), for the website.

    python tool/pontardawe_menu.py            read only: the venue's menu settings, sections, items, till products
    python tool/pontardawe_menu.py --till     read only: the till's screens and product fields
    python tool/pontardawe_menu.py --apply    publish the menu, ordering on, collection on

Run from the repository root on the owner's PC (cloud sessions cannot SSH).
--apply changes only Pontardawe's own menu: if it has no sections yet, it
makes them from the till's food, hot drink and soft drink screens (SECTIONS
below; the manager can edit them after in Dine-in), then sets its dinein_venue
row: the address pontardawe-rfc, the club's name, phone and address, the club
red, and is_published, ordering_open and collection_open. Prices stay the
till's. No other venue is touched.
"""
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import deploy_memberships as dm  # noqa: E402  (.env.claude and the ssh helper)

SLUG = "pontardawe-rfc"
DB = f"cd {dm.BACKOFFICE} && mariadb $(grep -E '^DB_NAME=' .env | cut -d= -f2) -t"

FIND = f"""
SET @email = (SELECT office FROM epos_loyalty_app WHERE slug = '{SLUG}' LIMIT 1);
SET @office = COALESCE((SELECT office_id FROM dinein_venue WHERE slug = '{SLUG}' LIMIT 1),
                       (SELECT id FROM offices WHERE contact_email = @email LIMIT 1));
"""

CHECK = FIND + """
SELECT @email AS office_email, @office AS office_id, (SELECT name FROM offices WHERE id = @office) AS office_name;
SELECT slug, display_name, is_published, ordering_open, collection_open, collection_minutes, schedule_enabled, phone
  FROM dinein_venue WHERE office_id = @office;
SELECT s.id, s.name, COUNT(i.id) AS dishes FROM dinein_sections s LEFT JOIN dinein_items i ON i.section_id = s.id
 WHERE s.office_id = @office GROUP BY s.id ORDER BY s.sort_order, s.id;
SELECT COUNT(*) AS till_products FROM bo_products WHERE email = @email;
SELECT COUNT(*) AS tables_with_codes FROM floor_tables WHERE office_id = @office AND qr_enabled = 1 AND public_id IS NOT NULL;
"""

TILL = FIND + """
SELECT s.id, s.name, COUNT(b.id) AS product_keys FROM epos_screens s
  LEFT JOIN epos_screen_buttons b ON b.screen_id = s.id AND b.kind = 'product'
 WHERE s.office = @email GROUP BY s.id ORDER BY s.id;
SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bo_products';
"""

APPLY = FIND + f"""
INSERT INTO dinein_venue (office_id, slug, display_name, phone, address_line, postcode, accent_colour,
                          is_published, ordering_open, collection_open, collection_minutes)
VALUES (@office, '{SLUG}', 'Pontardawe RFC', '01792 864811', 'Ynysderw Road, Pontardawe', 'SA8 4EG', '#C41414',
        1, 1, 1, 20)
ON DUPLICATE KEY UPDATE slug = '{SLUG}',
  display_name = COALESCE(NULLIF(display_name, ''), 'Pontardawe RFC'),
  phone = COALESCE(NULLIF(phone, ''), '01792 864811'),
  address_line = COALESCE(NULLIF(address_line, ''), 'Ynysderw Road, Pontardawe'),
  postcode = COALESCE(NULLIF(postcode, ''), 'SA8 4EG'),
  is_published = 1, ordering_open = 1, collection_open = 1,
  collection_minutes = COALESCE(collection_minutes, 20);
"""


# The online menu, made from the till's own food screens the first time only
# (when the venue has no sections yet). Alcohol is left off: the website takes
# food, hot and soft drinks; drinks from the bar are ordered at the bar.
SECTIONS = [
    ("Breakfast", ["BREAKFAST", "Eggs Benedict", "Pancakes"]),
    ("Lunch", ["LUNCH", "Jacket Potato", "Wraps", "Loaded Fries", "Basket Meals"]),
    ("Carvery", ["CARVERY"]),
    ("Kids", ["KIDS", "Kids Breakfast", "Kids Pancakes"]),
    ("Desserts", ["DESSERTS"]),
    ("Snacks", ["SNACKS"]),
    ("Hot drinks", ["HOT DRINKS"]),
    ("Soft drinks", ["SOFT DRINKS"]),
    # Match tickets, once the club has a Tickets screen on the till; the
    # website's Tickets page lists this section (public/js/tickets.js).
    ("Tickets", ["TICKETS", "MATCH TICKETS"]),
]


def menu_sql():
    out = [FIND, "SET @fresh = ((SELECT COUNT(*) FROM dinein_sections WHERE office_id = @office) = 0);"]
    for n, (name, screens) in enumerate(SECTIONS, 1):
        names = ", ".join(f"'{x}'" for x in screens)
        out.append(f"""
INSERT INTO dinein_sections (office_id, name, sort_order) SELECT @office, '{name}', {n} FROM DUAL WHERE @fresh;
SET @s = IF(@fresh, LAST_INSERT_ID(), NULL);
INSERT INTO dinein_items (section_id, office_id, plu_id, name, sort_order)
SELECT @s, @office, p.pluid, MIN(p.product_name), MIN(sc.id * 1000 + b.grid_row * 20 + b.grid_col)
  FROM epos_screens sc
  JOIN epos_screen_buttons b ON b.screen_id = sc.id AND b.kind = 'product'
  JOIN bo_products p ON p.pluid = b.plu_id AND p.email = @email
 WHERE @fresh AND sc.office = @email AND sc.name IN ({names})
   AND p.price > 0 AND COALESCE(p.is_modifier, 0) = 0 AND COALESCE(p.active, 1) = 1
 GROUP BY p.pluid;""")
    return "\n".join(out)


def run(sql):
    sql = " ".join(line.strip() for line in sql.strip().splitlines())
    dm.ssh("run", f'{DB} -e "{sql}" 2>&1 | grep -v Deprecated')


if __name__ == "__main__":
    if "--till" in sys.argv:
        print("▶ Pontardawe RFC's till screens (read only)")
        run(TILL)
        raise SystemExit
    if "--apply" in sys.argv:
        print("▶ making the online menu from the till's food screens (first time only)")
        run(menu_sql())
        print("▶ publishing Pontardawe RFC's menu")
        run(APPLY)
    print("▶ Pontardawe RFC's menu settings")
    run(CHECK)
    dm.ssh("run", "curl -sS -o /dev/null -w 'menu API  %{http_code}\\n' "
           f"https://menu.vesopa.com/api/public/dinein/venue/{SLUG}", check=False)
