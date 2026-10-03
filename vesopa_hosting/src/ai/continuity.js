/**
 * Carrying on: which device this is, which conversation, and what the
 * customer has in progress. Signed-in customers only; a visitor's
 * conversation stays in their own browser as before (assistant.js) and is
 * handed over when they sign in.
 *
 *   DEVICES. The widget keeps a random key in the browser and sends it with
 *   each turn. Only its SHA-256 is stored, with the kind of device and its
 *   system read from the browser's own description. Recognising a device
 *   never signs anybody in or skips a check -- the same rule Vesopa Auth
 *   keeps for its own remembered devices. It is used to keep replies short on
 *   a phone and to say "you started this on your laptop".
 *
 *   SESSIONS. A customer has conversations, not one endless transcript. The
 *   newest is carried on from any device until they press New chat. The
 *   first time a customer is given a session, the messages they already had
 *   are put in it, so nothing they said before disappears.
 *
 *   PROJECTS. What is under way on the account right now: a Studio draft,
 *   domains still being set up, paid orders still being built, hosting still
 *   in setup or in a trial that is ending, open tickets. This is the
 *   customer's own account data, so it is only ever given to the Bedrock
 *   model (src/ai/llm.js), never to DeepSeek.
 */

const crypto = require('crypto');
const db = require('../db');

const ID = /^[A-Za-z0-9_-]{16,64}$/;
const CARRY_ON_DAYS = 14;

function deviceOf(ua) {
  const s = String(ua || '');
  const kind = /iPad|Tablet|Android(?!.*Mobile)/i.test(s) ? 'tablet' : /Mobi|iPhone|Android/i.test(s) ? 'phone' : 'desktop';
  const platform = /Windows/i.test(s) ? 'Windows' : /iPhone|iPad|iOS/i.test(s) ? 'iOS' : /Android/i.test(s) ? 'Android'
    : /Mac OS X|Macintosh/i.test(s) ? 'macOS' : /CrOS/i.test(s) ? 'ChromeOS' : /Linux/i.test(s) ? 'Linux' : '';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return { kind, platform, browser };
}

/** "laptop or desktop (Windows)", the way a person would say it. */
function describeDevice(d) {
  if (!d) return '';
  const what = d.kind === 'desktop' ? 'computer' : d.kind || 'device';
  return d.platform ? `${what} (${d.platform})` : what;
}

/** This browser, as a row: created the first time it is seen. */
async function device(customer, key, ua) {
  if (!customer || !ID.test(String(key || ''))) return null;
  const hash = crypto.createHash('sha256').update(String(key)).digest('hex');
  const d = deviceOf(ua);
  await db.query(
    `INSERT INTO ai_devices (customer_id, key_hash, kind, platform, browser) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE kind = VALUES(kind), platform = VALUES(platform), browser = VALUES(browser), last_seen = NOW()`,
    [customer.id, hash, d.kind, d.platform, d.browser],
  );
  const row = await db.one('SELECT id, kind, platform, browser FROM ai_devices WHERE customer_id = ? AND key_hash = ?', [customer.id, hash]);
  return row || null;
}

/**
 * The conversation this turn belongs to. `wanted` is the public id the widget
 * holds; `fresh` starts a new one. Otherwise the newest recent one carries on.
 */
async function session(customer, { wanted, fresh, dev } = {}) {
  if (!customer) return null;
  let row = null;
  if (!fresh && ID.test(String(wanted || ''))) {
    row = await db.one('SELECT * FROM ai_sessions WHERE public_id = ? AND customer_id = ?', [wanted, customer.id]);
  }
  if (!row && !fresh) {
    row = await db.one(
      `SELECT * FROM ai_sessions WHERE customer_id = ? AND updated_at >= NOW() - INTERVAL ${CARRY_ON_DAYS} DAY
        ORDER BY updated_at DESC, id DESC LIMIT 1`, [customer.id]);
  }
  if (row) {
    row.device = row.device_id ? await db.one('SELECT id, kind, platform FROM ai_devices WHERE id = ?', [row.device_id]) : null;
    return row;
  }
  const publicId = crypto.randomBytes(16).toString('base64url').slice(0, 22);
  const first = !(await db.one('SELECT id FROM ai_sessions WHERE customer_id = ? LIMIT 1', [customer.id]));
  const res = await db.query('INSERT INTO ai_sessions (public_id, customer_id, device_id) VALUES (?, ?, ?)', [publicId, customer.id, dev ? dev.id : null]);
  const id = res.insertId;
  // Their first session takes in what they had already said, so nothing goes missing.
  if (first) await db.query('UPDATE ai_messages SET session_id = ? WHERE customer_id = ? AND session_id IS NULL', [id, customer.id]);
  return { id, public_id: publicId, customer_id: customer.id, device_id: dev ? dev.id : null, title: '', device: dev || null, isNew: true };
}

/** After a turn: the title from the first thing they asked, and where they were. */
async function touch(sess, { userText, pageUrl } = {}) {
  if (!sess) return;
  const title = !sess.title && userText ? String(userText).replace(/\s+/g, ' ').trim().slice(0, 80) : null;
  await db.query(
    `UPDATE ai_sessions SET updated_at = NOW(), last_page = ?${title ? ', title = ?' : ''} WHERE id = ?`,
    title ? [String(pageUrl || '').slice(0, 300), title, sess.id] : [String(pageUrl || '').slice(0, 300), sess.id],
  );
  if (title) sess.title = title;
}

/** Their recent conversations, newest first, for "carry on" in the widget. */
async function list(customer) {
  if (!customer) return [];
  const rows = await db.query(
    `SELECT s.public_id, s.title, s.updated_at, d.kind, d.platform
       FROM ai_sessions s LEFT JOIN ai_devices d ON d.id = s.device_id
      WHERE s.customer_id = ? ORDER BY s.updated_at DESC LIMIT 8`, [customer.id]);
  return rows.map((r) => ({ id: r.public_id, title: r.title || 'Conversation', updated_at: r.updated_at, device: describeDevice(r.kind ? r : null) }));
}

async function forget(customer, publicId) {
  if (!customer || !ID.test(String(publicId || ''))) return;
  const row = await db.one('SELECT id FROM ai_sessions WHERE public_id = ? AND customer_id = ?', [publicId, customer.id]);
  if (!row) return;
  await db.query('DELETE FROM ai_messages WHERE session_id = ? AND customer_id = ?', [row.id, customer.id]);
  await db.query('DELETE FROM ai_sessions WHERE id = ?', [row.id]);
}

function ago(when) {
  const ms = Date.now() - new Date(when).getTime();
  if (!Number.isFinite(ms)) return '';
  const h = Math.round(ms / 3600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** What is under way on the account. Each part is optional: a missing table or column never breaks a turn. */
async function projects(customer) {
  if (!customer) return { items: [] };
  const items = [];
  const safe = async (fn) => { try { await fn(); } catch { /* that part is unavailable */ } };
  await safe(async () => {
    const d = await db.one(
      `SELECT s.name, s.site, s.updated_at, v.kind, v.platform FROM ai_studio_drafts s LEFT JOIN ai_devices v ON v.id = s.device_id
        WHERE s.customer_id = ?`, [customer.id]);
    if (d) {
      let published = '';
      try { published = String(JSON.parse(d.site).publishedTo || ''); } catch { /* an old draft */ }
      const on = describeDevice(d.kind ? d : null);
      items.push({
        kind: 'studio_site',
        what: `Vesopa Studio site "${d.name || 'untitled'}" ${published ? `(published to ${published})` : '(not published yet)'}, last edited ${ago(d.updated_at)}${on ? ` on their ${on}` : ''}`,
        page: '/build',
      });
    }
  });
  await safe(async () => {
    const rows = await db.query(
      `SELECT d.domain, r.started_at FROM domain_setup_runs r JOIN domains d ON d.id = r.domain_id
        WHERE r.customer_id = ? AND r.status = 'running' ORDER BY r.id DESC LIMIT 5`, [customer.id]);
    for (const r of rows) items.push({ kind: 'domain_setup', what: `${r.domain} is still being set up`, updated: ago(r.started_at), page: '/panel/domains' });
  });
  await safe(async () => {
    const rows = await db.query(
      `SELECT reference, status, created_at FROM orders WHERE customer_id = ? AND status IN ('pending','paid','provisioning')
        ORDER BY id DESC LIMIT 5`, [customer.id]);
    for (const r of rows) items.push({ kind: 'order', what: `order ${r.reference} is ${r.status === 'pending' ? 'waiting for payment' : 'paid and being set up'}`, updated: ago(r.created_at), page: '/panel' });
  });
  await safe(async () => {
    const rows = await db.query(
      `SELECT primary_domain, status, setup_step, is_trial, next_due_at FROM services WHERE customer_id = ? AND status IN ('pending','active')
        ORDER BY id DESC LIMIT 10`, [customer.id]);
    for (const r of rows) {
      if (r.status === 'pending' || (r.setup_step && r.setup_step !== 'done')) {
        items.push({ kind: 'hosting_setup', what: `hosting for ${r.primary_domain || 'a new site'} is not finished setting up (step: ${r.setup_step || r.status})`, page: '/panel' });
      }
      if (r.is_trial && r.next_due_at) {
        const days = Math.ceil((new Date(r.next_due_at).getTime() - Date.now()) / 86_400_000);
        if (days >= 0 && days <= 7) items.push({ kind: 'trial_ending', what: `the free trial for ${r.primary_domain || 'their hosting'} ends in ${days} day${days === 1 ? '' : 's'}`, page: '/panel' });
      }
    }
  });
  await safe(async () => {
    const rows = await db.query(`SELECT id, subject, status FROM tickets WHERE customer_id = ? AND status <> 'closed' ORDER BY id DESC LIMIT 5`, [customer.id]);
    for (const r of rows) items.push({ kind: 'ticket', what: `support ticket "${r.subject}" is ${r.status === 'answered' ? 'answered, waiting for them' : 'open'}`, page: `/panel/tickets/${r.id}` });
  });
  return { items };
}

/** One line for the prompt: what is in progress, or nothing. */
function projectsLine(p) {
  const items = p && Array.isArray(p.items) ? p.items : [];
  if (!items.length) return '';
  return `IN PROGRESS ON THEIR ACCOUNT: ${items.slice(0, 6).map((i) => i.what).join('; ')}. Offer to pick one up if it fits what they ask; call projects() for details.`;
}

// ---- Studio drafts ---------------------------------------------------------

const MAX_DRAFT_BYTES = 400_000;

async function readDraft(customer) {
  if (!customer) return null;
  const row = await db.one('SELECT name, site, history, updated_at FROM ai_studio_drafts WHERE customer_id = ?', [customer.id]);
  if (!row) return null;
  let site = null;
  let history = [];
  try { site = JSON.parse(row.site); } catch { return null; }
  try { history = JSON.parse(row.history || '[]'); } catch { history = []; }
  return { site, history, updated_at: row.updated_at };
}

async function writeDraft(customer, { site, history, dev }) {
  if (!customer || !site || typeof site !== 'object') return false;
  const siteJson = JSON.stringify(site);
  const historyJson = JSON.stringify(Array.isArray(history) ? history.slice(-30) : []);
  if (siteJson.length + historyJson.length > MAX_DRAFT_BYTES) return false;
  await db.query(
    `INSERT INTO ai_studio_drafts (customer_id, name, site, history, device_id) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), site = VALUES(site), history = VALUES(history), device_id = VALUES(device_id), updated_at = NOW()`,
    [customer.id, String(site.name || '').slice(0, 120), siteJson, historyJson, dev ? dev.id : null],
  );
  return true;
}

async function clearDraft(customer) {
  if (!customer) return;
  await db.query('DELETE FROM ai_studio_drafts WHERE customer_id = ?', [customer.id]);
}

module.exports = { deviceOf, describeDevice, device, session, touch, list, forget, projects, projectsLine, readDraft, writeDraft, clearDraft, ID };
