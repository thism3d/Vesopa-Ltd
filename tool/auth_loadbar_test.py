"""Prove the progress bar actually appears, in each of the three cases.

    python tool/auth_loadbar_test.py

THE THREE CASES ARE GENUINELY DIFFERENT PATHS and only one of them is obvious.

  1. a link the no-reload router handles      nav.js calls bar.start()
  2. a form being submitted                   loadbar.js's own submit listener
  3. a link the router deliberately leaves alone — /auth/google, which hands
     off to a provider — loadbar.js's click listener

The third is the one that matters most and the one a casual test misses: it is
the longest wait on the whole site, and it is the one case where the router is
NOT involved, so a bar wired only into the router would leave it silent exactly
where the silence is worst.

The bar is watched through a MutationObserver rather than by taking a
screenshot at the right moment. It runs for a few hundred milliseconds and then
finishes on its own, so a screenshot is a race that passes on a slow day and
fails on a fast one — which is worse than no test, because it teaches you to
ignore the failure.

AND THE OBSERVATION IS WRITTEN TO sessionStorage, which is the part that took
two attempts to get right. Two of the three cases END IN A REAL NAVIGATION, and
a navigation destroys the observer along with every variable on `window` — so a
check made afterwards runs on a fresh document where the flag was never set, and
reports a failure that is really the test measuring the wrong page. Blocking the
request instead does not help: aborting a top-level navigation replaces the
document too. sessionStorage is per-origin and per-tab, and survives both.
"""

import sys

from playwright.sync_api import sync_playwright

BASE = "https://auth.vesopa.com"

# Installed before the click, so the bar cannot appear and vanish between the
# click and the check. It records rather than samples.
WATCHER = """
() => {
  sessionStorage.removeItem('barSeen');
  sessionStorage.removeItem('workingSeen');
  const check = () => {
    const bar = document.getElementById('loadbar');
    if (bar && bar.classList.contains('on')) sessionStorage.setItem('barSeen', '1');
    if (document.querySelector('.is-working')) sessionStorage.setItem('workingSeen', '1');
  };
  check();
  new MutationObserver(check).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'style'],
  });
}
"""

SEEN = "() => sessionStorage.getItem('barSeen') === '1'"
WORKED = "() => sessionStorage.getItem('workingSeen') === '1'"

passed = 0
failed = 0


def check(condition, what, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  OK  {what}")
    else:
        failed += 1
        print(f"  FAIL {what}" + (f"\n       {detail}" if detail else ""))


def main():
    with sync_playwright() as play:
        browser = play.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})

        # Console errors are collected everywhere EXCEPT the provider step.
        #
        # That step deliberately starts a sign-in with Google and walks away
        # from it, which is a 400 by design — counting it would mean the test
        # fails every run for a reason that is the test's own doing, and a suite
        # that always fails is a suite nobody reads.
        problems = []
        collecting = {"on": True, "step": "start"}
        page.on(
            "console",
            lambda m: problems.append(f"[{collecting['step']}] {m.type}: {m.text}")
            if m.type == "error" and collecting["on"]
            else None,
        )
        page.on(
            "response",
            lambda r: problems.append(f"[{collecting['step']}] HTTP {r.status} {r.url}")
            if r.status >= 400 and collecting["on"]
            else None,
        )

        # ------------------------------------------------------------------
        collecting["step"] = "the bar exists at all"
        print("> the bar exists at all")
        page.goto(f"{BASE}/login", wait_until="load")
        check(
            page.evaluate("() => typeof window.VesopaLoadbar === 'object'"),
            "loadbar.js loaded and published its interface",
        )
        check(
            page.evaluate("() => !!window.__vesopaNavReady"),
            "and nav.js initialised alongside it",
        )

        # ------------------------------------------------------------------
        collecting["step"] = "submitting the sign-in form"
        print("> submitting the sign-in form")
        # The field is left empty on purpose: the server answers with the form
        # and a message, so nothing is sent to anybody's mailbox. The bar
        # behaves identically either way — it starts on submit, before the
        # server has said anything at all, which is the entire point of it.
        #
        # That answer is an HTTP 400, deliberately — `backToLogin` in
        # routes/auth.js re-renders the form with that status because the
        # request genuinely was malformed. It is not a fault, so this step does
        # not count it.
        collecting["on"] = False
        page.evaluate(WATCHER)
        page.click("button[data-submit]")
        page.wait_for_load_state("load")
        check(page.evaluate(SEEN), "the bar started on submit")
        check(
            page.evaluate(WORKED),
            "and the button went quiet, so a second press does nothing",
        )
        check(
            "Enter" in page.content() or "form-error" in page.content(),
            "and the form came back with a message rather than a blank page",
        )
        collecting["on"] = True

        # ------------------------------------------------------------------
        collecting["step"] = "a link the router handles"
        print("> a link the router handles")
        page.goto(f"{BASE}/", wait_until="load")
        page.evaluate(WATCHER)
        page.click('a[href="/docs"]')
        page.wait_for_timeout(300)
        check(page.evaluate(SEEN), "the bar started on a routed link")
        page.wait_for_timeout(900)
        check(
            page.evaluate(
                "() => { const b = document.getElementById('loadbar');"
                " return !!b && !b.classList.contains('on'); }"
            ),
            "and finished once the new page was on screen — the element surviving "
            "the body swap is the point",
        )
        check("/docs" in page.url, "and the page actually changed", page.url)

        # ------------------------------------------------------------------
        collecting["step"] = "a link the router deliberately leaves alone"
        print("> a link the router deliberately leaves alone")
        page.goto(f"{BASE}/login", wait_until="load")
        provider = page.query_selector('a[data-provider]')
        if not provider:
            print("  --  no provider buttons on this server; skipped")
        else:
            page.evaluate(WATCHER)
            collecting["on"] = False
            provider.click()
            # The click leaves this origin entirely — Google answers next — so
            # the flag is read after coming back. sessionStorage is per-origin
            # and per-tab, so it is still there.
            page.wait_for_timeout(1200)
            page.goto(f"{BASE}/login", wait_until="load")
            check(
                page.evaluate(SEEN),
                "the bar started on the hand-off to a provider",
            )
            collecting["on"] = True

        # ------------------------------------------------------------------
        collecting["step"] = "and it does not start where nothing happens"
        print("> and it does not start where nothing happens")
        page.goto(f"{BASE}/login", wait_until="load")
        page.evaluate(WATCHER)
        # The link needs text and a size, or Playwright waits for an invisible
        # element for ever. A zero-height anchor is not a thing a person could
        # click either, so making it real is also making the test honest.
        page.evaluate(
            "() => { const a = document.createElement('a');"
            " a.href = location.href; a.id = 'same'; a.textContent = 'same page';"
            " document.body.appendChild(a); }"
        )
        page.click("#same")
        page.wait_for_timeout(250)
        check(
            not page.evaluate(SEEN),
            "a link to the current page starts no bar that nothing would finish",
        )

        check(not problems, "no console errors", "; ".join(problems[:3]))
        browser.close()

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
