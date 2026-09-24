"""Sort the Products table by Department and measure the header arrows."""
import os
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(
    r"C:\Users\Administrator\Documents\Vesopa-Claude-Images\2026-09-08-backoffice-1680"
)
BASE = "https://backoffice.vesopaepos.com"

MEASURE = """
() => {
  const out = [];
  const ths = document.querySelectorAll('#view-products th');
  for (const th of ths) {
    const r = th.getBoundingClientRect();
    // How wide the header's own content wants to be, arrow included.
    const probe = document.createElement('span');
    const cs = getComputedStyle(th);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:'
      + cs.font + ';letter-spacing:' + cs.letterSpacing
      + ';text-transform:' + cs.textTransform;
    probe.textContent = th.textContent.trim() + (th.classList.contains('sorted') ? ' \\u25b2' : '');
    document.body.appendChild(probe);
    const want = probe.getBoundingClientRect().width;
    probe.remove();
    out.push({
      text: th.textContent.trim(),
      sorted: th.classList.contains('sorted'),
      boxW: +r.width.toFixed(1),
      contentWant: +want.toFixed(1),
      padL: cs.paddingLeft, padR: cs.paddingRight,
      overflowBy: +(want + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
        - r.width).toFixed(1),
      whiteSpace: cs.whiteSpace,
      overflow: cs.overflow,
    });
  }
  return out;
}
"""


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
    cfg = env()
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        page.goto(BASE, wait_until="networkidle")
        page.fill("#email", cfg["VESOPA_TEST_EMAIL"])
        page.fill("#password", cfg["VESOPA_TEST_PASSWORD"])
        page.click('button[type="submit"]')
        page.wait_for_selector("#app:not([hidden])", timeout=20000)
        page.goto(f"{BASE}/products", wait_until="networkidle")
        page.wait_for_timeout(1500)

        print("--- unsorted ---")
        for row in page.evaluate(MEASURE):
            print(" ", row)

        page.click('#view-products th[data-sort="department_name"]')
        page.wait_for_timeout(800)
        print("--- sorted by department ---")
        for row in page.evaluate(MEASURE):
            print(" ", row)
        page.screenshot(path=str(OUT / "before-products-sorted-dept.png"))

        page.click('#view-products th[data-sort="group_name"]')
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / "before-products-sorted-group.png"))
        browser.close()


if __name__ == "__main__":
    main()
