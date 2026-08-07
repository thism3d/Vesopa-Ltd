/**
 * How many mailboxes an account may have, and where that number came from.
 *
 * Two sources, added together:
 *
 *   included   Every hosting plan comes with mailboxes at your own domain —
 *              the number is on the plan row (`plans.mailboxes`), so an admin
 *              changing what Business includes is an edit, not a deploy. They
 *              are free with the plan and they are also the whole of the free
 *              allowance: there is no per-mailbox charge hiding underneath.
 *
 *   purchased  A business email plan, bought per mailbox. That is the product
 *              for somebody who wants email WITHOUT hosting a site here, and
 *              for somebody who has outgrown what their plan includes.
 *
 * Both only count while they are ACTIVE. A suspended hosting account or a
 * lapsed mail subscription grants nothing, which is the point of an allowance
 * being computed rather than stamped onto a row at purchase time.
 *
 * Marketing email plans are deliberately not counted. They are contact lists
 * and campaign sends, not mailboxes, and a customer with 10,000 contacts does
 * not thereby have 10,000 inboxes.
 */

const db = require('./db');
const hestia = require('./integrations/hestia');

/**
 * What this customer is entitled to, what they are using, and why.
 *
 * `used` is read from the NODE, not from a counter of our own. Support can add
 * a mailbox by hand and a database counter would not know — in the direction
 * that lets somebody exceed what they bought. When the node cannot be reached,
 * `used` is null and `remaining` is null with it: the honest answer is "we
 * cannot tell", and the create path refuses rather than guessing zero.
 */
async function allowance(customer) {
  const [hosting, purchased] = await Promise.all([
    db.query(
      `SELECT s.id, p.name AS plan_name, p.mailboxes
         FROM services s JOIN plans p ON p.id = s.plan_id
        WHERE s.customer_id = ? AND s.status = 'active'`,
      [customer.id],
    ),
    db.query(
      `SELECT e.units, ep.name AS plan_name
         FROM email_services e JOIN email_plans ep ON ep.id = e.email_plan_id
        WHERE e.customer_id = ? AND e.status = 'active' AND ep.family = 'business'`,
      [customer.id],
    ),
  ]);

  const sources = [
    ...hosting.map((h) => ({ label: `${h.plan_name} hosting`, count: Number(h.mailboxes || 0) })),
    ...purchased.map((p) => ({ label: p.plan_name, count: Number(p.units || 0) })),
  ].filter((s) => s.count > 0);

  const included = hosting.reduce((sum, h) => sum + Number(h.mailboxes || 0), 0);
  const extra = purchased.reduce((sum, p) => sum + Number(p.units || 0), 0);
  const total = included + extra;

  let used = null;
  let error = '';
  if (customer.hestia_user) {
    try {
      used = await hestia.countMailAccounts(customer.hestia_user);
    } catch (err) {
      error = err.message;
    }
  } else {
    used = 0;
  }

  return {
    included,
    purchased: extra,
    total,
    used,
    remaining: used === null ? null : Math.max(0, total - used),
    full: used !== null && used >= total,
    sources,
    error,
  };
}

/**
 * May this account create another mailbox right now?
 *
 * Reasons are written for the customer, because they are what the panel prints.
 * "Not allowed" tells somebody nothing; "your plan includes 25 and you are
 * using all 25" tells them what to do next, and the panel links the mail plans
 * beside it.
 */
async function canCreate(customer) {
  const quota = await allowance(customer);

  if (!quota.total) {
    return {
      ok: false,
      quota,
      reason: 'Mailboxes come with a hosting plan, or with a business email plan. Neither is active on this account yet.',
    };
  }
  if (quota.used === null) {
    return { ok: false, quota, reason: 'We could not reach the mail server just now. Please try again in a minute.' };
  }
  if (quota.used >= quota.total) {
    return {
      ok: false,
      quota,
      reason: `You are using all ${quota.total} mailbox${quota.total === 1 ? '' : 'es'} on this account. `
        + 'Add a business email plan for more, or free one up by deleting a mailbox you no longer need.',
    };
  }
  return { ok: true, quota };
}

/**
 * The mail domains this customer may create a mailbox at.
 *
 * A mailbox lives at a domain, and the domain has to be one we actually serve:
 * ours to serve means registered here or verified as pointing here. Accepting
 * any name typed into the box would have the node accept mail for domains that
 * belong to other people.
 */
async function usableDomains(customer) {
  return db.query(
    `SELECT d.domain
       FROM domains d
      WHERE d.customer_id = ?
        AND d.status = 'active'
        AND (d.source <> 'external' OR d.ns_verified_at IS NOT NULL)
      ORDER BY d.domain`,
    [customer.id],
  );
}

module.exports = { allowance, canCreate, usableDomains };
