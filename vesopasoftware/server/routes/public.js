import { Router } from "express";
import rateLimit from "express-rate-limit";
import { exec, one, nextRef } from "../lib/db.js";
import { priceQuote, SERVICES, TIERS, FEATURES, TIMELINES, moneyRound } from "../lib/pricing.js";
import { sendMail, layout, esc } from "../lib/mail.js";
import { notifyAdmins } from "../lib/notify.js";
import { config } from "../lib/config.js";

const router = Router();

// Public write endpoints are the one place an anonymous visitor can put rows in
// our database, so they are the one place that needs a rate limit.
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many submissions. Try again in a few minutes." },
});

const clean = (v, max = 255) => String(v ?? "").trim().slice(0, max);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

/** The option catalogue, so the quote form renders from the same source that
 *  prices it. */
router.get("/pricing", (req, res) => {
  res.json({ services: SERVICES, tiers: TIERS, features: FEATURES, timelines: TIMELINES, currency: config.currency });
});

/** Live estimate as the visitor moves the controls. No writes, no limit. */
router.post("/estimate", (req, res) => {
  const { min, max } = priceQuote(req.body || {});
  res.json({ ok: true, min, max, currency: config.currency });
});

/** Submit a quotation request from the marketing site. */
router.post("/quote", limiter, async (req, res) => {
  try {
    const b = req.body || {};
    // Honeypot: a field hidden from people, filled in by bots. Answer 200 so
    // the bot has nothing to learn from the difference.
    if (clean(b.website)) return res.json({ ok: true, ref: "VQ-0000" });

    const name = clean(b.name, 120);
    const email = clean(b.email, 190).toLowerCase();
    if (!name) return res.status(400).json({ ok: false, error: "Your name is required." });
    if (!validEmail(email)) return res.status(400).json({ ok: false, error: "A valid email is required." });

    const features = Array.isArray(b.features) ? b.features.map((f) => clean(f, 40)).slice(0, 20) : [];
    const priced = priceQuote({ ...b, features });
    const ref = await nextRef("quotes", "ref", "VQ");

    // If they already hold an account under this address, hang the quote on it
    // so it shows up in their portal the moment they log in.
    const existing = await one("SELECT id FROM users WHERE email = ?", [email]);

    const result = await exec(
      `INSERT INTO quotes (ref, user_id, name, email, phone, company, service_type, scope_tier,
                           timeline, features, estimate_min, estimate_max, currency, message)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ref, existing?.id || null, name, email, clean(b.phone, 40) || null, clean(b.company, 150) || null,
       priced.service.id, priced.tier.id, priced.timeline.id, JSON.stringify(features),
       priced.min, priced.max, config.currency, clean(b.message, 4000) || null],
    );

    const band = `${moneyRound(priced.min, config.currency)} – ${moneyRound(priced.max, config.currency)}`;
    const featureList = priced.features.map((f) => f.label).join(", ") || "none selected";

    await sendMail({
      to: email,
      subject: `Your Vesopa estimate — ${ref}`,
      template: "quote_customer",
      text: `Thanks ${name}. Your reference is ${ref}. Estimate: ${band}.`,
      html: layout({
        heading: `Your estimate: ${band}`,
        lines: [
          `Thanks, ${esc(name)} — we have your brief and your reference is <b>${ref}</b>.`,
          `<b>${esc(priced.service.label)}</b> · ${esc(priced.tier.label)} · ${esc(priced.timeline.label)}`,
          `Included: ${esc(featureList)}.`,
          `That band is an estimate, not a price. One of us reads every brief and comes back with a firm figure and a plan — usually within one working day.`,
          `Create an account with this address and the quote, the project and every invoice sit in one place you can log into.`,
        ],
        cta: { label: "Open your portal", href: `${config.baseUrl}/portal/register?email=${encodeURIComponent(email)}` },
      }),
    });

    await sendMail({
      to: config.mail.admin,
      subject: `New quote ${ref} — ${name} — ${band}`,
      template: "quote_admin",
      text: `${name} <${email}> ${priced.service.label} ${band}\n\n${clean(b.message, 4000)}`,
      html: layout({
        heading: `New quote ${ref}`,
        lines: [
          `<b>${esc(name)}</b>${b.company ? ` · ${esc(clean(b.company, 150))}` : ""}`,
          `${esc(email)}${b.phone ? ` · ${esc(clean(b.phone, 40))}` : ""}`,
          `${esc(priced.service.label)} · ${esc(priced.tier.label)} · ${esc(priced.timeline.label)}`,
          `Estimate <b>${band}</b> · features: ${esc(featureList)}`,
          clean(b.message, 4000) ? `“${esc(clean(b.message, 4000))}”` : "No message left.",
        ],
        cta: { label: "Open in admin", href: `${config.baseUrl}/portal/admin/quotes/${result.insertId}` },
      }),
    });

    await notifyAdmins({
      kind: "quote",
      title: `New quote ${ref} — ${name}`,
      body: `${priced.service.label} · ${band}`,
      href: `/portal/admin/quotes/${result.insertId}`,
    });

    res.json({ ok: true, ref, min: priced.min, max: priced.max, currency: config.currency });
  } catch (err) {
    console.error("quote submit failed:", err);
    res.status(500).json({ ok: false, error: "Could not save that. Please email info@vesopasoftware.com." });
  }
});

/** Plain contact form — "email sending from the web". */
router.post("/contact", limiter, async (req, res) => {
  try {
    const b = req.body || {};
    if (clean(b.website)) return res.json({ ok: true });

    const name = clean(b.name, 120);
    const email = clean(b.email, 190).toLowerCase();
    const message = clean(b.message, 4000);
    if (!name || !validEmail(email) || !message) {
      return res.status(400).json({ ok: false, error: "Name, a valid email and a message are all required." });
    }

    const result = await exec(
      "INSERT INTO enquiries (name, email, phone, subject, message) VALUES (?,?,?,?,?)",
      [name, email, clean(b.phone, 40) || null, clean(b.subject, 190) || null, message],
    );

    await sendMail({
      to: config.mail.admin,
      subject: `Enquiry from ${name}${b.subject ? ` — ${clean(b.subject, 190)}` : ""}`,
      template: "enquiry_admin",
      text: `${name} <${email}>\n\n${message}`,
      html: layout({
        heading: "New enquiry",
        lines: [`<b>${esc(name)}</b> · ${esc(email)}${b.phone ? ` · ${esc(clean(b.phone, 40))}` : ""}`,
                `“${esc(message)}”`],
        cta: { label: "Open in admin", href: `${config.baseUrl}/portal/admin/enquiries` },
      }),
    });

    await sendMail({
      to: email,
      subject: "We have your message — Vesopa Software",
      template: "enquiry_customer",
      text: `Thanks ${name}, we have your message and will reply shortly.`,
      html: layout({
        heading: "Message received",
        lines: [`Thanks, ${esc(name)} — this landed with us and a person will read it.`,
                `We reply to everything, usually within one working day.`],
      }),
    });

    await notifyAdmins({
      kind: "enquiry",
      title: `Enquiry from ${name}`,
      body: message.slice(0, 200),
      href: "/portal/admin/enquiries",
    });

    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    console.error("contact submit failed:", err);
    res.status(500).json({ ok: false, error: "Could not send that. Please email info@vesopasoftware.com." });
  }
});

export default router;
