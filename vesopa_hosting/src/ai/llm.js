/**
 * Which model answers, by the Vesopa model policy (shared/ai-client).
 *
 *   DeepSeek (deepseek-flash, thinking off) answers everything that carries
 *   no customer personal data: visitors asking about plans and domains, the
 *   guide on public pages, and Vesopa Studio (with contact details masked,
 *   src/builder/agent.js). Gemini covers for it when it is down.
 *
 *   Bedrock keeps every turn that does carry personal data: a signed-in
 *   customer (their name, email, domains, orders and tickets are in the
 *   prompt or a tool away), a page with personal details typed into it, or a
 *   message that contains an email address or phone number. DeepSeek runs in
 *   China and the owner's rule (2026-10-03) is that customer personal data
 *   never goes there.
 *
 *   If Bedrock is not configured, a personal turn still gets an answer, but a
 *   stripped one: no account tools, no name, no history, and identifiers
 *   removed from what is sent (see agent.js, `safe`).
 */

const path = require('path');
const config = require('../config');
const bedrock = require('./bedrock');
const { createClient, redact, looksPersonal, BudgetError } = require('./vesopa_ai');

const client = createClient({
  app: 'vesopa_hosting',
  apiKey: config.AI.DEEPSEEK_API_KEY,
  gemini: { apiKey: config.AI.GEMINI_API_KEY },
  dailyCapUsd: config.AI.DAILY_CAP_USD,
  logDir: config.AI.USAGE_DIR || path.join(__dirname, '..', '..', 'logs', 'ai-usage'),
});

/* A field somebody fills with details about a person, judged by its kind or name. */
const PERSONAL_FIELD = /email|e-mail|phone|tel|mobile|password|passcode|first.?name|last.?name|full.?name|surname|address|street|postcode|post.?code|zip|city|town|county|birth|dob|card|cvc|cvv|iban|sort.?code|account.?number|registrant|contact/i;

/** Does this page snapshot have personal details typed into it? */
function pageHasPersonal(page) {
  const els = page && Array.isArray(page.elements) ? page.elements : [];
  for (const e of els) {
    const value = e && e.value != null ? String(e.value).trim() : '';
    if (!value) continue;
    const kind = `${e.kind || ''} ${e.tag || ''} ${e.name || ''} ${e.label || ''} ${e.placeholder || ''}`;
    if (PERSONAL_FIELD.test(kind) || looksPersonal(value)) return true;
  }
  return looksPersonal(page && page.text) || looksPersonal(Array.isArray(page && page.alerts) ? page.alerts.join(' ') : '');
}

/** The page with typed-in values that might name a person removed. */
function safePage(page) {
  if (!page || typeof page !== 'object') return page;
  const elements = (Array.isArray(page.elements) ? page.elements : []).map((e) => {
    if (!e || e.value == null || e.value === '') return e;
    const kind = `${e.kind || ''} ${e.tag || ''} ${e.name || ''} ${e.label || ''} ${e.placeholder || ''}`;
    return { ...e, value: PERSONAL_FIELD.test(kind) ? '[filled in]' : redact(e.value) };
  });
  return {
    ...page,
    text: page.text ? redact(page.text) : page.text,
    alerts: Array.isArray(page.alerts) ? page.alerts.map((a) => redact(a)) : page.alerts,
    headings: Array.isArray(page.headings) ? page.headings.map((h) => redact(h)) : page.headings,
    elements,
  };
}

module.exports = {
  client,
  /** DeepSeek or its Gemini backup is configured. */
  enabled: () => client.enabled,
  /** Bedrock is configured, so personal turns have a UK/EU-side home. */
  bedrockEnabled: () => bedrock.ENABLED,
  pageHasPersonal,
  safePage,
  redact,
  looksPersonal,
  BudgetError,
};
