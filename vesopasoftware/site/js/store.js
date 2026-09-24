/* Microsoft Store links.
 *
 * Three apps, three product IDs, two ways to reach each of them:
 *
 *   ms-windows-store://pdp/?productid=XXX   opens the Store app on Windows
 *   https://apps.microsoft.com/detail/XXX   opens the web listing anywhere
 *
 * The protocol handler is much the better arrival — it lands on the install
 * button inside the Store rather than on a web page with an install button
 * that then launches the Store. But it only exists on Windows, and on anything
 * else the browser either does nothing or shows a "no app can open this" box,
 * so it is only ever handed to a machine that can use it.
 *
 * The detection is deliberately conservative. `navigator.userAgentData` is the
 * honest answer where it exists (Chromium on Windows); the UA string is the
 * fallback, and "Windows NT" in a UA is a reliable enough signal. Anything we
 * are not sure about gets the https link, because a web listing that works
 * everywhere beats a deep link that fails silently.
 */

export const APPS = {
  epos: {
    id: "9PDMNJXNFZCW",
    name: "Vesopa EPOS",
    tag: "The till",
  },
  kitchen: {
    id: "9P29NN3R5PGS",
    name: "Vesopa Kitchen",
    tag: "The pass",
  },
  display: {
    id: "9P8JCLQ5M3SQ",
    name: "Vesopa Customer Display",
    tag: "The second screen",
  },
};

/**
 * iPhone or iPad.
 *
 * iPadOS 13+ deliberately reports itself as a Mac — same user agent, same
 * `navigator.platform` of "MacIntel" — so the only reliable tell is that a Mac
 * does not have a touchscreen. `maxTouchPoints > 1` on a MacIntel is an iPad.
 *
 * Worth getting right because fullscreen is not offered on these: Safari
 * treats an upward scroll as "give me the browser chrome back" and drops
 * straight out of it, and its own exit control sits on top of the page's
 * top-left corner. Offering a button that fights the OS is worse than not
 * offering it, so on iOS the invitation is sound only.
 */
export function isIOS() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

/** True when this machine can honour ms-windows-store://. */
export function isWindows() {
  const d = navigator.userAgentData;
  if (d && typeof d.platform === "string") return d.platform === "Windows";
  return /Windows NT/i.test(navigator.userAgent);
}

export const webUrl = (id) => `https://apps.microsoft.com/detail/${id}`;
export const deepUrl = (id) => `ms-windows-store://pdp/?productid=${id}`;

/** The best URL for this visitor. */
export const storeUrl = (id) => (isWindows() ? deepUrl(id) : webUrl(id));

/**
 * Point every [data-store] element at the right destination.
 *
 * The element carries the app key; this fills in href, and on Windows adds a
 * fallback so a machine with the protocol registered but the Store app missing
 * still gets somewhere useful. The fallback is a timer rather than an error
 * event, because a failed protocol navigation reports nothing at all — the
 * page simply stays where it is. If we are still visible a beat later, the
 * handler did not take, so open the web listing instead.
 */
export function wireStoreLinks(root = document) {
  const win = isWindows();

  for (const el of root.querySelectorAll("[data-store]")) {
    const app = APPS[el.dataset.store];
    if (!app) continue;

    el.href = win ? deepUrl(app.id) : webUrl(app.id);
    el.setAttribute("data-platform", win ? "windows" : "web");
    if (!win) { el.target = "_blank"; el.rel = "noopener"; }

    if (!el.getAttribute("aria-label")) {
      el.setAttribute("aria-label", `${app.name} on the Microsoft Store`);
    }

    if (win) {
      el.addEventListener("click", () => {
        const left = () => { document.removeEventListener("visibilitychange", left); };
        document.addEventListener("visibilitychange", left);
        setTimeout(() => {
          // Still here, still visible: the Store never came forward.
          if (!document.hidden) window.open(webUrl(app.id), "_blank", "noopener");
          document.removeEventListener("visibilitychange", left);
        }, 1400);
      });
    }
  }
}

/**
 * Mount Microsoft's own <ms-store-badge> into every [data-badge] slot.
 *
 * Progressive enhancement, and it must stay that way. The component is a
 * module loaded from get.microsoft.com, so it is subject to that request
 * succeeding: an offline visitor, a blocked third party or a corporate proxy
 * all end with no custom element ever being defined. Every slot therefore
 * already contains our own working link in the markup, and the badge is only
 * allowed to replace it once the element has actually upgraded.
 *
 * `window-mode="full"` is Microsoft's own recommendation for a link that
 * should open the full Store rather than a mini popup.
 */
export function mountBadges(root = document) {
  const slots = [...root.querySelectorAll("[data-badge]")];
  if (!slots.length) return;

  const src = "https://get.microsoft.com/badge/ms-store-badge.bundled.js";
  if (!document.querySelector(`script[src="${src}"]`)) {
    const s = document.createElement("script");
    s.type = "module";
    s.src = src;
    s.async = true;
    document.head.appendChild(s);
  }

  customElements.whenDefined("ms-store-badge").then(() => {
    for (const slot of slots) {
      const app = APPS[slot.dataset.badge];
      if (!app || slot.querySelector("ms-store-badge")) continue;

      const badge = document.createElement("ms-store-badge");
      badge.setAttribute("productid", app.id.toLowerCase());
      badge.setAttribute("window-mode", "full");
      badge.setAttribute("theme", "dark");
      // "large" renders around 380x90 — on a Mac it came out bigger than the
      // heading above it and read as the section's main event rather than its
      // call to action. "small" is Microsoft's own compact lockup.
      badge.setAttribute("size", "small");
      badge.setAttribute("language", "en-gb");
      badge.setAttribute("animation", "on");
      slot.appendChild(badge);
      slot.classList.add("has-badge");   // hides our fallback link
    }
  }).catch(() => { /* badge never loaded; the markup link stands */ });
}
