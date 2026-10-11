"""Pontardawe RFC's online menu (menu.vesopa.com/pontardawe-rfc), for the website.

    python tool/pontardawe_menu.py            read only: the venue's menu settings, sections, items, till products
    python tool/pontardawe_menu.py --till     read only: the till's screens and product fields
    python tool/pontardawe_menu.py --apply    publish the menu, ordering on, collection on

Run from the repository root on the owner's PC (cloud sessions cannot SSH).
--apply only changes Pontardawe's own dinein_venue row: the address
pontardawe-rfc, the club's name, phone and address, the club red, and the
switches is_published, ordering_open and collection_open. It does not touch
the menu's sections or dishes, prices or any other venue.
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


def run(sql):
    sql = " ".join(line.strip() for line in sql.strip().splitlines())
    dm.ssh("run", f'{DB} -e "{sql}" 2>&1 | grep -v Deprecated')


if __name__ == "__main__":
    if "--till" in sys.argv:
        print("▶ Pontardawe RFC's till screens (read only)")
        run(TILL)
        raise SystemExit
    if "--apply" in sys.argv:
        print("▶ publishing Pontardawe RFC's menu")
        run(APPLY)
    print("▶ Pontardawe RFC's menu settings")
    run(CHECK)
    dm.ssh("run", "curl -sS -o /dev/null -w 'menu API  %{http_code}\\n' "
           f"https://menu.vesopa.com/api/public/dinein/venue/{SLUG}", check=False)
