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

/* ---------- data subject requests ----------
 *
 * Deletion, export, correction, objection. Apple and Google both require a
 * working request route before they will verify an organisation, and "email
 * us" is not one — a form that lands somewhere a human is already looking is.
 *
 * It writes into `enquiries` rather than a table of its own, on purpose. A
 * dedicated table would be a second inbox nobody has a habit of opening, and
 * a deletion request that is filed correctly and never read is worse than one
 * that arrives as an ordinary enquiry. The subject line carries the kind, so
 * it sorts and searches, and the admin sees it beside everything else.
 *
 * The reply to the requester is the identity check: we act on a confirmation
 * sent from the address on the account, never on the form alone. Anyone can
 * type a stranger's email into a form, and deleting an account because they
 * did would be the actual data breach.                                      */
const REQUEST_KINDS = {
  delete:  "Deletion request",
  export:  "Data export request",
  correct: "Correction request",
  stop:    "Do-not-contact request",
  object:  "Objection to processing",
};
const REQUEST_SCOPES = {
  portal:    "Portal account, projects, messages and files",
  enquiries: "Enquiries, quotes and estimate requests",
  apps:      "Data in a Vesopa application or hosted back office",
  marketing: "Marketing and mailing lists",
  all:       "Everything held about them",
};

router.post("/data-request", limiter, async (req, res) => {
  try {
    const b = req.body || {};
    if (clean(b.website)) return res.json({ ok: true, ref: "DR-0000" });

    const name = clean(b.name, 120);
    const email = clean(b.email, 190).toLowerCase();
    if (!name) return res.status(400).json({ ok: false, error: "Your name is required." });
    if (!validEmail(email)) return res.status(400).json({ ok: false, error: "A valid email address is required." });
    if (!b.confirm) {
      return res.status(400).json({ ok: false, error: "Please tick the box to confirm you understand what this does." });
    }

    const kindKey = Object.hasOwn(REQUEST_KINDS, clean(b.kind, 20)) ? clean(b.kind, 20) : "delete";
    const kind = REQUEST_KINDS[kindKey];
    // A single tickbox arrives as a string, several as an array.
    const raw = Array.isArray(b.scope) ? b.scope : b.scope ? [b.scope] : [];
    const scopes = raw.map((s) => REQUEST_SCOPES[clean(s, 20)]).filter(Boolean);
    const scopeList = scopes.length ? scopes.join("; ") : "Not specified — ask them.";
    const detail = clean(b.message, 4000);

    const body =
      `${kind} submitted from ${config.baseUrl}/delete-my-data\n\n` +
      `Name:   ${name}\n` +
      `Email:  ${email}\n` +
      `Scope:  ${scopeList}\n\n` +
      `${detail || "No further detail given."}\n\n` +
      `ACTION: reply to ${email} to confirm identity before deleting anything. ` +
      `Due within 30 days of that confirmation.`;

    const result = await exec(
      "INSERT INTO enquiries (name, email, phone, subject, message) VALUES (?,?,?,?,?)",
      [name, email, null, kind, body],
    );
    // The reference is the row id, not a counter of its own: `enquiries` has no
    // ref column, and inventing a second sequence for a handful of requests a
    // year would be one more thing to keep unique for no gain. Written back so
    // the admin list is searchable by the reference the requester was given.
    const ref = `DR-${String(result.insertId).padStart(4, "0")}`;
    await exec("UPDATE enquiries SET subject = ? WHERE id = ?", [`${kind} — ${ref}`, result.insertId]);
    const subject = `${kind} — ${ref}`;

    // The requester's copy is not a courtesy — it is the identity check, and
    // it is the only thing we act on.
    await sendMail({
      to: email,
      subject: `${kind} received — please confirm`,
      template: "data_request_customer",
      text: `We have your ${kind.toLowerCase()}. Reply to this email to confirm it was you, and we will act within 30 days.`,
      html: layout({
        heading: kind,
        lines: [
          `Thanks, ${esc(name)} — we have your request and its reference is <b>${esc(ref)}</b>.`,
          `<b>Reply to this email to confirm it was you.</b> We cannot act on a request typed into a form by itself: anyone could enter your address, and acting on that would be the very thing this policy exists to prevent.`,
          `Covering: ${esc(scopeList)}`,
          `Once you confirm we act within 30 days — usually within seven — and write to tell you when it is done. Some records, principally invoices, we are required by UK tax law to keep for six years; the deletion policy explains exactly which.`,
        ],
        cta: { label: "Read the deletion policy", href: `${config.baseUrl}/data-deletion` },
      }),
    });

    await sendMail({
      to: config.mail.admin,
      subject: `${subject} — ${name} <${email}>`,
      template: "data_request_admin",
      text: body,
      html: layout({
        heading: kind,
        lines: [
          `<b>${esc(name)}</b> · ${esc(email)}`,
          `Covering: ${esc(scopeList)}`,
          detail ? `“${esc(detail)}”` : "No further detail given.",
          `<b>Confirm identity by replying to them first.</b> Statutory deadline is one month from confirmation.`,
        ],
        cta: { label: "Open in admin", href: `${config.baseUrl}/portal/admin/enquiries` },
      }),
    });

    await notifyAdmins({
      kind: "enquiry",
      title: `${kind} — ${name}`,
      body: `${email} · ${scopeList}`,
      href: "/portal/admin/enquiries",
    });

    res.json({ ok: true, id: result.insertId, ref });
  } catch (err) {
    console.error("data request failed:", err);
    res.status(500).json({ ok: false, error: `Could not file that. Please email ${config.mail.support || "support@vesopasoftware.com"}.` });
  }
});

export default router;
