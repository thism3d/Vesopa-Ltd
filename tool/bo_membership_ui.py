"""Drive the Membership settings on the live Loyalty page and put them back.

Reads what the venue has set first and restores it in a `finally`, so a failed
expectation still leaves the venue's own numbers where they were.
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(
    r"C:\Users\Administrator\Documents\Vesopa-Claude-Images\2026-09-08-backoffice-1680"
)
BASE = "https://backoffice.vesopaepos.com"


def env():
    values = {}
    for line in (ROOT / ".env.claude-tools").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "membership"
    cfg = env()
    OUT.mkdir(parents=True, exist_ok=True)
    before = None

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": 1440, "height": 1000}, color_scheme="dark"
        )
        try:
            page.goto(BASE, wait_until="networkidle")
            page.fill("#email", cfg["VESOPA_TEST_EMAIL"])
            page.fill("#password", cfg["VESOPA_TEST_PASSWORD"])
            page.click('button[type="submit"]')
            page.wait_for_selector("#app:not([hidden])", timeout=20000)
            page.goto(f"{BASE}/loyalty", wait_until="networkidle")
            page.wait_for_timeout(2000)

            before = page.evaluate(
                """async () => {
                  const s = await api('/loyalty');
                  return {
                    membership_term_months: s.membership_term_months,
                    membership_fee_minor: s.membership_fee_minor,
                    membership_plu: s.membership_plu,
                  };
                }"""
            )
            print("as the venue has it:", before)

            note = page.eval_on_selector(
                "#loyalty-membership-note", "e => e.textContent.trim()"
            )
            print("note with no product:", note)
            page.screenshot(path=str(OUT / f"{tag}-loyalty.png"))

            # Point it at a real product and check the note names it.
            plu = page.evaluate(
                "async () => (await api('/products'))[0].pluid"
            )
            page.fill('[data-loy="membership_plu"]', str(plu))
            page.fill('[data-loy="membership_term_months"]', "6")
            page.wait_for_timeout(400)
            print(
                "note with a product:",
                page.eval_on_selector(
                    "#loyalty-membership-note", "e => e.textContent.trim()"
                ),
            )
            page.click("#loyalty-save")
            page.wait_for_timeout(2000)

            saved = page.evaluate(
                """async () => {
                  const s = await api('/loyalty');
                  return {
                    membership_term_months: s.membership_term_months,
                    membership_fee_minor: s.membership_fee_minor,
                    membership_plu: s.membership_plu,
                  };
                }"""
            )
            print("saved:", saved)
            ok = saved["membership_plu"] == plu and saved["membership_term_months"] == 6
            print("round trip:", "ok" if ok else "FAILED")
            page.screenshot(path=str(OUT / f"{tag}-loyalty-set.png"))
            if not ok:
                sys.exit(1)
        finally:
            if before:
                page.evaluate(
                    """async (was) => api('/loyalty', {
                         method: 'PUT', body: JSON.stringify(was) })""",
                    before,
                )
                page.wait_for_timeout(1000)
                back = page.evaluate(
                    """async () => {
                      const s = await api('/loyalty');
                      return {
                        membership_term_months: s.membership_term_months,
                        membership_fee_minor: s.membership_fee_minor,
                        membership_plu: s.membership_plu,
                      };
                    }"""
                )
                print("put back:", back, "->", "ok" if back == before else "MISMATCH")
            browser.close()


if __name__ == "__main__":
    main()
