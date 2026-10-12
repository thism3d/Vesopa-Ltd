"""Pontardawe RFC's member cards against the till's card rules (read only).

    python tool/pontardawe_cards_check.py

Run from the repository root on the owner's PC (cloud sessions cannot SSH).
Prints the venue's card prefixes, its loyalty schemes and their prefixes, how
its members' card numbers start, and any product barcode that is also a
member's card number. Nothing is written.
"""
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import pontardawe_menu as pm  # noqa: E402  (FIND, run)

CHECK = pm.FIND + """
SELECT @email AS office_email, @office AS office_id;
SELECT * FROM epos_card_settings WHERE office = @email;
SELECT id, name, card_prefix, is_membership, active FROM epos_loyalty_schemes WHERE office = @email;
SELECT COUNT(*) AS customers, SUM(card_number IS NULL OR card_number = '') AS no_card,
       SUM(membership_status IS NOT NULL) AS with_membership_status
  FROM epos_customers WHERE email_key = @email;
SELECT LEFT(card_number, 4) AS starts, LENGTH(card_number) AS digits, COUNT(*) AS cards
  FROM epos_customers WHERE email_key = @email AND card_number <> ''
 GROUP BY starts, digits ORDER BY cards DESC LIMIT 20;
SELECT c.name, c.card_number, c.scheme_id, c.membership_status, c.membership_expiry
  FROM epos_customers c WHERE c.email_key = @email ORDER BY c.created_at DESC LIMIT 12;
SELECT p.pluid, p.product_name, p.barcode, c.name AS member
  FROM bo_products p JOIN epos_customers c ON c.email_key = @email AND c.card_number = p.barcode
 WHERE p.email = @email LIMIT 20;
SELECT p.pluid, p.product_name, p.barcode FROM bo_products p
 WHERE p.email = @email AND p.barcode REGEXP '^[0-9]{6,}$'
 ORDER BY p.pluid DESC LIMIT 15;
"""

if __name__ == "__main__":
    print("▶ Pontardawe RFC's cards (read only)")
    pm.run(CHECK)
