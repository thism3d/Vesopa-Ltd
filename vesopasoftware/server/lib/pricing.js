/* The quotation model.
 *
 * One source of truth, imported by both the public quote form (which renders
 * the options and prices the answers live in the browser) and the server route
 * that stores the quote. If these two ever disagree, a customer sees one number
 * on the site and a different one in their email — so the browser copy is
 * served FROM here, at /portal/pricing.js, rather than duplicated by hand.
 *
 * Every figure is a GBP band, not a price. A quote is an estimate until a human
 * has read the brief; the portal calls it "estimate" everywhere for that reason.
 */

export const CURRENCY_SYMBOL = { GBP: "£", USD: "$", EUR: "€", CAD: "CA$" };

/** Base build cost by what is being made. min/max bracket the same scope done
 *  simply vs done thoroughly. */
export const SERVICES = [
  {
    id: "website",
    label: "Brand website",
    blurb: "Marketing site, CMS, the thing your customers judge you by.",
    min: 1800, max: 4500,
  },
  {
    id: "ecommerce",
    label: "Online shop",
    blurb: "Catalogue, checkout, payments, stock, order flow.",
    min: 3500, max: 9000,
  },
  {
    id: "webapp",
    label: "Web application",
    blurb: "Accounts, dashboards, business logic — software, not pages.",
    min: 6000, max: 20000,
  },
  {
    id: "mobile",
    label: "Mobile app",
    blurb: "iOS and Android, built once, shipped to both stores.",
    min: 8000, max: 25000,
  },
  {
    id: "epos",
    label: "EPOS / till system",
    blurb: "Counter, floor, kitchen pass and back office. Our home ground.",
    min: 7000, max: 22000,
  },
  {
    id: "hosting",
    label: "Hosting & infrastructure",
    blurb: "Servers, deployment, SSL, backups, monitoring, someone on call.",
    min: 600, max: 4000,
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
  { id: "brand",       label: "Brand & identity",        min: 700,  max: 2200, blurb: "Logo, palette, type, the lot." },
  { id: "payments",    label: "Payments",                min: 600,  max: 1800, blurb: "Card, or our own crypto layer." },
  { id: "accounts",    label: "Customer accounts",       min: 800,  max: 2400, blurb: "Login, profiles, permissions." },
  { id: "cms",         label: "Content editing",         min: 500,  max: 1600, blurb: "You change the words, not us." },
  { id: "integration", label: "Third-party integration", min: 700,  max: 3000, blurb: "Their API, your data, our glue." },
  { id: "analytics",   label: "Reporting & analytics",   min: 500,  max: 2000, blurb: "Dashboards that answer a question." },
  { id: "seo",         label: "SEO & performance",       min: 400,  max: 1400, blurb: "Fast, findable, measured." },
  { id: "support",     label: "Ongoing support",         min: 900,  max: 3600, blurb: "12 months of us keeping it up." },
];

/** Timeline multiplier — compressing a build costs money, patience saves it. */
export const TIMELINES = [
  { id: "rush",     label: "As soon as possible", blurb: "We reshuffle to start now.", mult: 1.25 },
  { id: "normal",   label: "Next 1–3 months",     blurb: "The normal run.",            mult: 1.0  },
  { id: "flexible", label: "No fixed date",       blurb: "Slot it around other work.", mult: 0.9  },
];

const byId = (list, id) => list.find((x) => x.id === id) || null;

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
