/* The quote builder and the contact form.
 *
 * Both post to the portal's public API on the same origin. The options and the
 * prices are fetched from /api/pricing rather than written here, so the figure
 * a visitor sees is the figure the server would calculate — there is only one
 * price list, and it lives in server/lib/pricing.js.
 *
 * The page works without this file: it is progressive decoration on a form
 * that is only ever submitted by fetch. If the API is unreachable, the form
 * says so and gives the email address instead of failing silently.
 */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const form = $("#quote-form");
  const contact = $("#contact-form");
  if (!form && !contact) return;

  const money = (n) => "£" + Math.round(Number(n) || 0).toLocaleString("en-GB");

  const show = (el, text, bad = false) => {
    if (!el) return;
    el.textContent = text;
    el.classList.add("on");
    el.classList.toggle("bad", bad);
  };

  /* ---------- quote builder ---------- */
  if (form) {
    const out = $("#q-estimate");
    const msg = $("#q-msg");
    const submit = $("#q-submit");
    const selService = $("#q-service");
    const selTier = $("#q-tier");
    const selTime = $("#q-timeline");
    const featureBox = $("#q-features");

    const fill = (sel, items, defaultId) => {
      sel.innerHTML = items
        .map((i) => `<option value="${i.id}"${i.id === defaultId ? " selected" : ""}>${i.label} — ${i.blurb}</option>`)
        .join("");
    };

    let priceTimer = null;
    let inFlight = null;

    const answers = () => {
      const fd = new FormData(form);
      const body = new URLSearchParams();
      body.set("service_type", fd.get("service_type") || "");
      body.set("scope_tier", fd.get("scope_tier") || "");
      body.set("timeline", fd.get("timeline") || "");
      for (const v of fd.getAll("features")) body.append("features", v);
      return body;
    };

    const reprice = async () => {
      // One request in flight at a time: dragging through the options fires a
      // dozen changes, and an out-of-order reply would show the wrong number.
      inFlight?.abort();
      inFlight = new AbortController();
      try {
        const r = await fetch("/api/estimate", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: answers(),
          signal: inFlight.signal,
        });
        const d = await r.json();
        out.textContent = `${money(d.min)} – ${money(d.max)}`;
      } catch (err) {
        if (err.name !== "AbortError") out.textContent = "—";
      }
    };

    const schedule = () => { clearTimeout(priceTimer); priceTimer = setTimeout(reprice, 120); };

    fetch("/api/pricing")
      .then((r) => r.json())
      .then((data) => {
        fill(selService, data.services, data.services[0].id);
        fill(selTier, data.tiers, "standard");
        fill(selTime, data.timelines, "normal");
        featureBox.innerHTML = data.features
          .map((f) => `<label class="opt">
              <input type="checkbox" name="features" value="${f.id}">
              <span>${f.label}<small>${f.blurb}</small></span>
            </label>`)
          .join("");
        reprice();
      })
      .catch(() => {
        out.textContent = "—";
        show(msg, "The estimator is offline. Email info@vesopasoftware.com and we will price it by hand.", true);
      });

    form.addEventListener("change", schedule);
    form.addEventListener("input", (e) => { if (e.target.matches("select")) schedule(); });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      if (!String(fd.get("name") || "").trim()) return show(msg, "Your name, please.", true);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(fd.get("email") || ""))) {
        return show(msg, "That email does not look right.", true);
      }

      const payload = {
        name: fd.get("name"), email: fd.get("email"),
        company: fd.get("company"), phone: fd.get("phone"),
        message: fd.get("message"), website: fd.get("website"),
        service_type: fd.get("service_type"), scope_tier: fd.get("scope_tier"),
        timeline: fd.get("timeline"), features: fd.getAll("features"),
      };

      submit.disabled = true;
      const label = submit.textContent;
      submit.textContent = "Sending…";
      try {
        const r = await fetch("/api/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || "That did not send.");
        form.querySelectorAll("input[type=text], input[type=email], input[type=tel], textarea, input:not([type])")
          .forEach((i) => { i.value = ""; });
        /* The estimate, and the one useful next step.
           Registering is entirely optional — the brief is already saved and a
           person is already reading it. But an account is where the answer
           comes back, and the register page claims this quote by email, so
           carrying the reference across means it can say so rather than
           silently attaching it. */
        show(msg,
          `Sent. Your reference is ${d.ref} and the estimate is ${money(d.min)} – ${money(d.max)}. ` +
          `Check your email — a person is reading the brief now.`);
        const email = String(fd.get("email") || "").trim();
        const next = document.createElement("a");
        next.className = "cta";
        next.style.marginTop = "1rem";
        next.href = `/portal/register?quote=${encodeURIComponent(d.ref)}`
          + (email ? `&email=${encodeURIComponent(email)}` : "");
        next.textContent = "Create an account to track it";
        msg.appendChild(document.createElement("br"));
        msg.appendChild(next);
      } catch (err) {
        show(msg, err.message || "Could not send that. Email info@vesopasoftware.com instead.", true);
      } finally {
        submit.disabled = false;
        submit.textContent = label;
      }
    });
  }

  /* ---------- contact ---------- */
  if (contact) {
    const msg = $("#c-msg");
    const submit = $("#c-submit");

    contact.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(contact);
      if (!String(fd.get("name") || "").trim()) return show(msg, "Your name, please.", true);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(fd.get("email") || ""))) {
        return show(msg, "That email does not look right.", true);
      }
      if (!String(fd.get("message") || "").trim()) return show(msg, "Write us a line first.", true);

      submit.disabled = true;
      const label = submit.textContent;
      submit.textContent = "Sending…";
      try {
        const r = await fetch("/api/contact", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(Object.fromEntries(fd)),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || "That did not send.");
        contact.reset();
        show(msg, "Got it. We reply to everything, usually within one working day.");
      } catch (err) {
        show(msg, err.message || "Could not send that. Email info@vesopasoftware.com instead.", true);
      } finally {
        submit.disabled = false;
        submit.textContent = label;
      }
    });
  }
})();
