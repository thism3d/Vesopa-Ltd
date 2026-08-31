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

const dns = require('node:dns');

const db = require('./db');
const hestia = require('./integrations/hestia');
const nameservers = require('./nameservers');
const { MAIL_HOSTNAME, WEBMAIL_URL, MAIL_PORTS } = require('./config');

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
    `SELECT d.domain, d.verify_method, d.mail_enabled
       FROM domains d
      WHERE d.customer_id = ?
        AND d.status = 'active'
        AND d.source <> 'subdomain'
        AND d.ns_verified_at IS NOT NULL
      ORDER BY d.domain`,
    [customer.id],
  );
}

/**
 * The settings a mail client needs.
 *
 * ONE HOSTNAME FOR EVERYBODY, and the customer's own domain appears only in the
 * username. `mail.<their domain>` — which is what this used to say — has no
 * certificate, so the instruction described a server that could not actually be
 * connected to; see MAIL_HOSTNAME in config.js.
 *
 * Only implicit-TLS ports are listed. There is no version of these settings
 * that sends a password in the clear because a client did not negotiate
 * STARTTLS.
 */
function connectionSettings(address = '') {
  return {
    host: MAIL_HOSTNAME,
    webmail: WEBMAIL_URL,
    username: address || 'your full email address',
    imap: { host: MAIL_HOSTNAME, port: MAIL_PORTS.imap, security: 'SSL/TLS' },
    smtp: { host: MAIL_HOSTNAME, port: MAIL_PORTS.smtp, security: 'SSL/TLS' },
    pop3: { host: MAIL_HOSTNAME, port: MAIL_PORTS.pop3, security: 'SSL/TLS' },
  };
}

/**
 * The DNS records a domain needs before mail can reach it.
 *
 * Only meaningful when the customer runs their own DNS. Where the zone is ours
 * these are already written and there is nothing to show — telling somebody to
 * add a record we have already added is how a working setup gets broken by a
 * well-meaning duplicate.
 *
 * SPF is `~all` rather than `-all` deliberately. A hard fail on a domain that
 * still sends from an old provider — during exactly the migration this feature
 * exists to support — bounces the customer's real mail. Soft fail marks it and
 * delivers it, and they can tighten it once they have moved.
 */
/**
 * Merge our SPF requirements into a record the domain already publishes.
 *
 * ---------------------------------------------------------------------------
 * A DOMAIN MAY PUBLISH EXACTLY ONE SPF RECORD. THIS IS THE WHOLE PROBLEM.
 * ---------------------------------------------------------------------------
 * RFC 7208 §4.5 is unambiguous: if a check finds more than one record starting
 * `v=spf1`, the result is **permerror**, and a permerror is not "one of them
 * wins" — it is a hard authentication failure for EVERY sender, including the
 * one that was working before.
 *
 * So telling a customer on Google Workspace to "add" our
 * `v=spf1 a mx include:mail.vesopa.com ~all` next to their existing
 * `v=spf1 include:_spf.google.com ~all` does not add us alongside them. It
 * breaks both, and it breaks them at the DNS level where nothing in our panel
 * would ever notice. That is exactly what this page used to instruct, because
 * it printed a fixed record without ever looking at what was already there —
 * even though `checkMailRecords()` had just read it.
 *
 * The merge keeps the customer's mechanisms in their original order, appends
 * only what we need and they do not already have, and PRESERVES THEIR OWN `all`
 * QUALIFIER. Rewriting a `-all` to `~all` would quietly loosen a policy they
 * chose deliberately; rewriting `~all` to `-all` would start bouncing their
 * mail. Neither is ours to decide.
 *
 * @param {string} existing  the SPF record currently published, or ''
 * @param {string} host      our mail hostname, e.g. mail.vesopa.com
 * @returns {{value: string, merged: boolean, alreadyOk: boolean,
 *            lookups: number, tooManyLookups: boolean, redirect: boolean}}
 */
function mergeSpf(existing, host) {
  const OURS = ['a', 'mx', `include:${host}`];
  const bare = `v=spf1 ${OURS.join(' ')} ~all`;

  const raw = String(existing || '').trim();
  if (!raw.toLowerCase().startsWith('v=spf1')) {
    return {
      value: bare, merged: false, alreadyOk: false,
      lookups: countLookups(OURS), tooManyLookups: false, redirect: false,
    };
  }

  // Everything after the version token, whitespace-separated.
  const terms = raw.split(/\s+/).slice(1).filter(Boolean);
  const lower = terms.map((t) => t.toLowerCase());

  /*
   * `redirect=` REPLACES the whole evaluation and cannot coexist with `all`.
   * Merging into one of those by hand is not something to do behind somebody's
   * back — it is flagged so the panel can say "this one needs a person".
   */
  const redirect = lower.some((t) => t.startsWith('redirect='));

  // Split off the trailing all-mechanism so ours can be inserted before it.
  const allIndex = lower.findIndex((t) => /^[-~?+]?all$/.test(t));
  const allTerm = allIndex >= 0 ? terms[allIndex] : '~all';
  const body = allIndex >= 0 ? terms.filter((_, i) => i !== allIndex) : terms.slice();

  const have = new Set(body.map((t) => t.toLowerCase()));
  const missing = OURS.filter((m) => !have.has(m));

  // Already authorises us, so there is nothing to change and nothing to show.
  if (!missing.length) {
    return {
      value: raw, merged: false, alreadyOk: true,
      lookups: countLookups(body), tooManyLookups: countLookups(body) > 10, redirect,
    };
  }

  const terms2 = [...body, ...missing];
  const lookups = countLookups(terms2);
  return {
    value: `v=spf1 ${terms2.join(' ')} ${allTerm}`,
    merged: true,
    alreadyOk: false,
    lookups,
    /*
     * SPF allows ten DNS-querying mechanisms per evaluation and returns
     * permerror past that — the same hard failure as a duplicate record. A
     * domain already close to the limit can be tipped over by our include, so
     * the number is reported rather than discovered by the customer later.
     */
    tooManyLookups: lookups > 10,
    redirect,
  };
}

/** How many of these terms cost a DNS lookup against SPF's limit of ten. */
function countLookups(terms) {
  return terms.filter((t) => /^(a|mx|ptr|exists:|include:|redirect=)/i.test(String(t))).length;
}

function recordsFor(domainRow, dkim = null, observedSpf = '', check = null) {
  /*
   * The SPF line is built from what the domain ALREADY publishes — see
   * mergeSpf(). A second `v=spf1` record is a permerror, not an addition, so
   * "add this record" is the wrong instruction for anyone already using Google,
   * Microsoft or a mailing-list provider.
   */
  const spf = mergeSpf(observedSpf, MAIL_HOSTNAME);

  const records = [
    {
      type: 'MX',
      name: '@',
      value: MAIL_HOSTNAME,
      priority: 10,
      satisfied: Boolean(check && check.mxOk),
      why: 'Sends mail for this domain to our server.',
    },
    {
      type: 'TXT',
      name: '@',
      value: spf.value,
      /*
       * DONE IS A STATE, NOT A MISSING INSTRUCTION.
       *
       * `mergeSpf` compares mechanisms as a SET, so a record that already
       * authorises us is recognised whatever order its terms are written in —
       * `a mx include:mail.vesopa.com include:spf.google.com` and
       * `include:spf.google.com a mx include:mail.vesopa.com` are the same
       * record to an SPF evaluator and both come back alreadyOk.
       *
       * But the page went on printing the row as something to go and add, so
       * somebody who had already done the work was told to do it again — in a
       * slightly different word order, which reads as "you got it wrong". A
       * satisfied record is now shown as satisfied.
       */
      satisfied: spf.alreadyOk,
      // The panel needs to say REPLACE rather than ADD when there is already a
      // record, and the two are not interchangeable advice.
      action: spf.merged ? 'replace' : 'add',
      merged: spf.merged,
      existing: spf.merged ? String(observedSpf).trim() : '',
      lookups: spf.lookups,
      tooManyLookups: spf.tooManyLookups,
      redirect: spf.redirect,
      why: spf.alreadyOk
        ? 'Your SPF record already authorises us. The order the terms are written in does not '
          + 'matter to an SPF check, so there is nothing to change here.'
        : spf.merged
        ? 'You already publish an SPF record, and a domain may only have ONE — a second '
          + 'record makes every sender fail, including your current one. This is your existing '
          + 'record with us added to it, so replace the old value with this rather than adding '
          + 'a new row.'
        : 'Tells other mail servers that we are allowed to send on your behalf. '
          + 'Without it your mail is far more likely to land in spam.',
    },
  ];
  if (dkim && dkim.name && dkim.value) {
    records.push({
      type: 'TXT',
      name: dkim.name,
      value: dkim.value,
      why: 'Signs your outgoing mail so it can be proved genuine.',
    });
  }
  records.push({
    type: 'TXT',
    name: '_dmarc',
    value: 'v=DMARC1; p=none; rua=mailto:postmaster@' + domainRow.domain,
    why: 'Asks other providers to report on mail claiming to be from you. '
      + 'Start with p=none and tighten it later.',
  });
  return records;
}

/**
 * Is this domain's mail actually pointed at us?
 *
 * Asked of the public DNS, because that is what other mail servers will ask.
 * Our own zone saying the right thing is not evidence when the domain is
 * delegated somewhere else — which is the exact case this check exists for.
 *
 * Never throws: a lookup that fails is reported as "not yet", since the only
 * thing hanging on it is whether to keep showing the instructions.
 */
async function checkMailRecords(domain) {
  const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
  try {
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
  } catch {
    /* fall back to the system resolver */
  }

  const [mx, txt] = await Promise.all([
    resolver.resolveMx(domain).catch(() => []),
    resolver.resolveTxt(domain).catch(() => []),
  ]);

  const wanted = MAIL_HOSTNAME.toLowerCase();
  const seen = mx.map((r) => String(r.exchange || '').toLowerCase().replace(/\.$/, ''));
  const spf = txt.map((parts) => parts.join('')).find((t) => t.toLowerCase().startsWith('v=spf1')) || '';

  /*
   * SPF IS NOT MATCHED BY NAME ALONE.
   *
   * `include:mail.vesopa.com` and `ip4:34.63.118.67` authorise exactly the same
   * server; one names it and one spells out its address, and both are things a
   * competent admin writes. Checking only for the hostname reported a correct
   * SPF record as missing — which would have had customers "fixing" a working
   * setup by pasting a second include next to one that already worked.
   *
   * The addresses are resolved from the hostname rather than written down, so
   * this stays true if the node moves. A lookup that fails simply falls back to
   * matching the name.
   */
  const ours = await nameservers.ourAddresses(MAIL_HOSTNAME).catch(() => []);
  const spfLower = spf.toLowerCase();
  const spfOk = Boolean(spf) && (
    spfLower.includes(wanted) || ours.some((ip) => spfLower.includes(ip))
  );

  return {
    mxOk: seen.includes(wanted),
    mxSeen: seen,
    spfOk,
    spfSeen: spf,
  };
}

module.exports = {
  allowance,
  canCreate,
  usableDomains,
  connectionSettings,
  recordsFor,
  checkMailRecords,
  mergeSpf,
};
