/* The quotation model.
 *
 * One source of truth, imported by both the public quote form (which renders
 * the options and prices the answers live in the browser) and the server route
 * that stores the quote. If these two ever disagree, a customer sees one number
 * on the site and a different one in their email — so the browser never holds
 * its own copy: site/js/forms.js and the portal's brief form fetch the option
 * list from /api/pricing and the figure from /api/estimate, both served FROM
 * here.
 *
 * Every figure is a GBP band, not a price. A quote is an estimate until a human
 * has read the brief; the portal calls it "estimate" everywhere for that reason.
 *
 * Ids are stored on every quote and project row. Never rename or remove one —
 * change its label, blurb or band instead, and add new ids for new work. An id
 * that disappears still prices (it falls back to the first entry), but the
 * quotes already filed under it lose their label.
 */

export const CURRENCY_SYMBOL = { GBP: "£", USD: "$", EUR: "€", CAD: "CA$" };

/** What is being made. min/max bracket the same scope done simply vs done
 *  thoroughly. `group` splits the picker into the products we already run and
 *  the things we build to order; forms that ignore it still get a flat list.
 *  The first entry is the default and the fallback for an unknown id. */
export const SERVICES = [
  /* ---- Vesopa products, set up for you ---- */
  {
    id: "epos", group: "Vesopa products",
    label: "Vesopa EPOS for your venue",
    blurb: "Till, kitchen screen and customer display, set up, loaded and trained.",
    min: 1200, max: 6000,
  },
  {
    id: "kiosk", group: "Vesopa products",
    label: "Self-order kiosk (Vesopa Express)",
    blurb: "Customers order and pay by card; it goes straight to the till and kitchen.",
    min: 1500, max: 6500,
  },
  {
    id: "qr_menu", group: "Vesopa products",
    label: "QR menu & online ordering",
    blurb: "Scan at the table, order from the menu, pay — on menu.vesopa.com.",
    min: 800, max: 3500,
  },
  {
    id: "loyalty", group: "Vesopa products",
    label: "Loyalty programme",
    blurb: "Vesopa Loyalty app and your own loyalty site: points, visits, news.",
    min: 900, max: 4000,
  },
  {
    id: "hosting", group: "Vesopa products",
    label: "Vesopa Cloud hosting, domains & email",
    blurb: "Moving you on to Vesopa Cloud. Monthly plans are priced on cloud.vesopa.com.",
    min: 300, max: 3000,
  },
  /* ---- built for you ---- */
  {
    id: "membership_app", group: "Built for you",
    label: "White-label membership or customer app",
    blurb: "Your brand on web, Windows and Android, with an admin console behind it.",
    min: 9000, max: 28000,
  },
  {
    id: "webapp", group: "Built for you",
    label: "Custom web application",
    blurb: "Accounts, dashboards, business logic — software, not pages.",
    min: 6000, max: 20000,
  },
  {
    id: "mobile", group: "Built for you",
    label: "Mobile app",
    blurb: "Android and iPhone, built once, shipped to both stores.",
    min: 8000, max: 25000,
  },
  {
    id: "website", group: "Built for you",
    label: "Brand website",
    blurb: "Marketing site, CMS, the thing your customers judge you by.",
    min: 1800, max: 4500,
  },
  {
    id: "ecommerce", group: "Built for you",
    label: "Online shop",
    blurb: "Catalogue, checkout, payments, stock, order flow.",
    min: 3500, max: 9000,
  },
];

/** Scope multiplier. Applied to the service base. */
export const TIERS = [
  { id: "starter",    label: "Starter",    blurb: "One clear job, done properly.",            mult: 0.75 },
  { id: "standard",   label: "Standard",   blurb: "The usual shape of a real project.",        mult: 1.0  },
  { id: "advanced",   label: "Advanced",   blurb: "Multiple systems, integrations, migration.", mult: 1.6 },
  { id: "enterprise", label: "Enterprise", blurb: "Multi-site, SLA, compliance, our people on it.", mult: 2.6 },
];

/** Flat add-ons, priced as a band each. */
export const FEATURES = [
  { id: "brand",       label: "Brand & identity",          min: 700,  max: 2200, blurb: "Logo, palette, type, the lot." },
  { id: "payments",    label: "Card & online payments",    min: 600,  max: 1800, blurb: "Dojo card machines, online checkout, or Vesopa Pay." },
  { id: "accounts",    label: "Customer accounts",         min: 800,  max: 2400, blurb: "Login, profiles, permissions." },
  { id: "vesopa_id",   label: "Vesopa ID sign-in",         min: 400,  max: 1200, blurb: "One secure sign-in shared with every Vesopa app." },
  { id: "cms",         label: "Content editing",           min: 500,  max: 1600, blurb: "You change the words, not us." },
  { id: "store",       label: "App store publishing",      min: 600,  max: 2000, blurb: "Microsoft Store, Google Play and the App Store: listing, review, updates." },
  { id: "hardware",    label: "ANPR & hardware",           min: 1500, max: 6000, blurb: "Number-plate cameras, barriers, printers, card machines." },
  { id: "integration", label: "Third-party integration",   min: 700,  max: 3000, blurb: "Their API, your data, our glue." },
  { id: "multisite",   label: "More than one site",        min: 600,  max: 2500, blurb: "Several venues or car parks under one account." },
  { id: "migration",   label: "Bring your data across",    min: 500,  max: 2500, blurb: "Members, menus, customers and history from what you use now." },
  { id: "analytics",   label: "Reporting & analytics",     min: 500,  max: 2000, blurb: "Dashboards that answer a question." },
  { id: "seo",         label: "SEO & performance",         min: 400,  max: 1400, blurb: "Fast, findable, measured." },
  { id: "training",    label: "On-site setup & training",  min: 400,  max: 1500, blurb: "We come to you, install it and show your staff." },
  { id: "support",     label: "Ongoing support",           min: 900,  max: 3600, blurb: "12 months of us keeping it up." },
];

/** Timeline multiplier — compressing a build costs money, patience saves it. */
export const TIMELINES = [
  { id: "rush",     label: "As soon as possible", blurb: "We reshuffle to start now.", mult: 1.25 },
  { id: "normal",   label: "Next 1–3 months",     blurb: "The normal run.",            mult: 1.0  },
  { id: "flexible", label: "No fixed date",       blurb: "Slot it around other work.", mult: 0.9  },
];

const byId = (list, id) => list.find((x) => x.id === id) || null;

/* Labels for ids read back off stored rows. An id this file no longer knows is
 * shown as itself rather than as a blank — the row is still somebody's quote. */
const labelIn = (list) => (id) => byId(list, id)?.label || String(id ?? "");
export const serviceLabel = labelIn(SERVICES);
export const tierLabel = labelIn(TIERS);
export const timelineLabel = labelIn(TIMELINES);
export const featureLabel = labelIn(FEATURES);

/** A quote's `features` column as an array, whichever way the driver hands
 *  it back: MySQL returns JSON parsed, MariaDB returns it as a string. */
export function featureIds(raw) {
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Where a quote stands, in the customer's words, and what happens next.
 *  Read by the dashboard, the quotes page and the admin list, so a status
 *  means the same thing wherever it is shown. */
export const QUOTE_STATUS = {
  new:       { label: "Received",      pill: "lime",
               next: "A person at Vesopa reads every brief. Expect a reply within one working day." },
  reviewing: { label: "Being scoped",  pill: "info",
               next: "We are working through the detail and may message you with questions." },
  quoted:    { label: "Quote ready",   pill: "warn",
               next: "Our firm quote is ready. Accept it and we open the project, or decline it and tell us why." },
  accepted:  { label: "Accepted",      pill: "ok",
               next: "Accepted. The project appears on your dashboard as soon as we have set it up." },
  declined:  { label: "Declined",      pill: "bad",
               next: "Closed. If anything changes, send a new brief and we will look again." },
};

/**
 * Price a set of answers.
 * Unknown ids fall back to the neutral option rather than throwing: a quote
 * form is a lead, and a lead is never worth losing to a validation error.
 */
export function priceQuote({ service_type, scope_tier, timeline, features = [] } = {}) {
  const service = byId(SERVICES, service_type) || SERVICES[0];
  const tier = byId(TIERS, scope_tier) || TIERS[1];
  const time = byId(TIMELINES, timeline) || TIMELINES[1];

  const picked = (Array.isArray(features) ? features : [])
    .map((id) => byId(FEATURES, id))
    .filter(Boolean);

  const addMin = picked.reduce((s, f) => s + f.min, 0);
  const addMax = picked.reduce((s, f) => s + f.max, 0);

  const mult = tier.mult * time.mult;
  // Round to the nearest £50 — a quote reading £4,137 implies a precision that
  // an estimate does not have.
  const round = (n) => Math.round(n / 50) * 50;

  return {
    service, tier, timeline: time, features: picked,
    min: round(service.min * mult + addMin),
    max: round(service.max * mult + addMax),
  };
}

export const money = (n, currency = "GBP") =>
  (CURRENCY_SYMBOL[currency] || "") +
  Number(n || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Whole-pound form, for headline estimates where pence are noise. */
export const moneyRound = (n, currency = "GBP") =>
  (CURRENCY_SYMBOL[currency] || "") + Math.round(Number(n) || 0).toLocaleString("en-GB");
