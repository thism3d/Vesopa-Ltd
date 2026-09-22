/**
 * A loyalty member's data, deleted when they ask.
 *
 * Vesopa Auth runs the deletion requests (vesopa_auth/src/deletion.js): the
 * page at auth.vesopa.com/delete-account, the administrator's queue, the
 * timer. What it cannot do is reach a venue's members, who live here. So this
 * back office is that app's privacy provider, and answers four signed calls:
 *
 *   POST /privacy/v1/lookup    what memberships does this address hold
 *   POST /privacy/v1/describe  a venue's app name, for the page heading
 *   POST /privacy/v1/erase     delete these memberships' personal data
 *   POST /privacy/v1/status    a request was cancelled or rejected
 *
 * and files requests the other way, for a member who asks inside the app:
 *
 *   POST /loyalty/v1/me/deletion   (the member's own token)
 *   GET  /loyalty/v1/me/deletion   what they asked for, to show in the app
 *
 * Both directions are signed with VESOPA_PRIVACY_SECRET, the same value
 * registered in Vesopa Auth by scripts/set-privacy-provider.js:
 * `vesopa-signature: t=<unix>,v1=hmac_sha256(secret, "t.body")`.
 *
 * WHAT ERASING A MEMBERSHIP DOES
 *
 *   gone      name, email, phone, photo (and its file), card and member
 *             number, password, passkeys, sign-in codes, app sessions,
 *             notification channels, inbox, the near-the-venue mark; the name and
 *             phone on their orders
 *   kept      the customer row as "Deleted member", with its points, visits
 *             and history: the venue's sales and points records, which it
 *             must keep for tax, now about nobody. Gift cards and deposits,
 *             whose money is still owed.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const SECRET = process.env.VESOPA_PRIVACY_SECRET || '';
const AUTH = (process.env.VESOPA_AUTH_ISSUER || 'https://auth.vesopa.com').replace(/\/+$/, '');
const APPLICATION = 'vesopa-loyalty';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');
const TOLERANCE_SECONDS = 300;
const DAY_CHOICES = [7, 15, 30];

// Offices and customers were created under different default collations; say
// which one to compare in, or MariaDB refuses the join on live.
const SAME_OFFICE = 'a.office COLLATE utf8mb4_general_ci = c.email_key COLLATE utf8mb4_general_ci';

function sign(body, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = crypto.createHmac('sha256', SECRET).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function signedByAuth(req) {
  if (!SECRET || SECRET.length < 32) return false;
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  const parts = Object.fromEntries(
    String(req.get('vesopa-signature') || '').split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2)
  );
  const t = Number(parts.t);
  if (!raw || !t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(sign(raw, t).split('v1=')[1]);
  const given = Buffer.from(String(parts.v1));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 255);
}

function monthYear(date) {
  return date ? new Date(date).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '';
}

function describeMembership(row) {
  const bits = [];
  if (row.card_number) bits.push(`card ending ${String(row.card_number).slice(-4)}`);
  bits.push(`${Number(row.points_balance) || 0} points`);
  if (row.created_at) bits.push(`member since ${monthYear(row.created_at)}`);
  return `Your membership: ${bits.join(', ')}. Photo, contact details, sign-in and notifications included.`;
}

async function membershipsFor(pool, email) {
  const [rows] = await pool.query(
    `SELECT c.id, c.email_key AS office, c.card_number, c.points_balance, c.created_at,
            a.slug, a.app_name
       FROM epos_customers c
       JOIN epos_loyalty_app a ON ${SAME_OFFICE}
      WHERE c.email IS NOT NULL AND LOWER(TRIM(c.email)) = ?
      ORDER BY c.created_at`,
    [email]
  );
  return rows;
}

/**
 * Erase one membership's personal data. Returns a sentence for the
 * administrator's page.
 */
async function eraseMembership(pool, customerId, email) {
  const [[c]] = await pool.query(
    'SELECT id, email_key AS office, email, phone, photo_url, name FROM epos_customers WHERE id = ?',
    [customerId]
  );
  if (!c) return { ok: true, detail: 'The membership had already gone.' };
  if (email && cleanEmail(c.email) !== email) {
    if (!c.email && c.name === 'Deleted member') return { ok: true, detail: 'The membership had already been erased.' };
    return { ok: false, detail: 'This membership no longer belongs to the address that asked. Check it by hand.' };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const scoped = [c.office, c.id];
    for (const table of [
      'epos_loyalty_app_sessions', 'epos_push_channels', 'epos_push_inbox',
      'epos_customer_near', 'epos_loyalty_passkeys',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await conn.query(`DELETE FROM ${table} WHERE office = ? AND customer_id = ?`, scoped);
    }
    await conn.query('DELETE FROM epos_loyalty_webauthn_challenges WHERE customer_id = ?', [c.id]);
    if (c.email || c.phone) {
      await conn.query(
        'DELETE FROM epos_loyalty_app_codes WHERE office = ? AND (email = ? OR (phone IS NOT NULL AND phone = ?))',
        [c.office, c.email || '', c.phone || '']
      );
    }
    await conn.query('UPDATE epos_orders SET customer_name = NULL, customer_phone = NULL WHERE customer_id = ?', [c.id]);
    await conn.query(
      `UPDATE epos_customers
          SET name = 'Deleted member', email = NULL, phone = NULL, card_number = NULL, member_no = NULL,
              notes = NULL, photo_url = NULL, password_hash = NULL, password_set_at = NULL,
              phone_verified_at = NULL, vesopa_sub = NULL, membership_expiry = NULL
        WHERE id = ?`,
      [c.id]
    );
    await conn.query(
      "UPDATE epos_privacy_requests SET status = 'completed', updated_at = NOW() WHERE office = ? AND customer_id = ?",
      scoped
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }

  if (c.photo_url && c.photo_url.startsWith('/uploads/')) {
    fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(c.photo_url))).catch(() => {});
  }
  return { ok: true, detail: 'Membership erased: contact details, photo, card, sign-in, notifications and nearby-offer mark removed; sales and points history kept without a name.' };
}

function privacyRoutes({ pool }) {
  const router = express.Router();

  router.use('/privacy/v1', (req, res, next) => {
    if (!signedByAuth(req)) return res.status(401).json({ error: 'invalid_signature' });
    return next();
  });

  router.post('/privacy/v1/lookup', async (req, res, next) => {
    try {
      const email = cleanEmail(req.body && req.body.email);
      if (!email.includes('@')) return res.json({ items: [] });
      const rows = await membershipsFor(pool, email);
      res.json({
        items: rows.map((r) => ({
          reference: r.id,
          label: r.app_name || 'Loyalty membership',
          detail: describeMembership(r),
          venue: r.slug || '',
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/privacy/v1/describe', async (req, res, next) => {
    try {
      const [[app]] = await pool.query('SELECT app_name FROM epos_loyalty_app WHERE slug = ?', [String(req.body && req.body.venue || '')]);
      res.json({ name: app ? app.app_name : null });
    } catch (e) {
      next(e);
    }
  });

  router.post('/privacy/v1/erase', async (req, res, next) => {
    try {
      const email = cleanEmail(req.body && req.body.email);
      const references = (Array.isArray(req.body && req.body.references) ? req.body.references : []).slice(0, 50);
      const results = [];
      for (const reference of references) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await eraseMembership(pool, String(reference), email);
          results.push({ reference, ...r });
        } catch (error) {
          console.error('[privacy] erase failed:', error.message);
          results.push({ reference, ok: false, detail: 'The back office could not erase this membership. It is safe to try again.' });
        }
      }
      console.log(`[privacy] erase for request ${String(req.body && req.body.request || '')}: ${results.filter((r) => r.ok).length}/${results.length} done`);
      res.json({ results });
    } catch (e) {
      next(e);
    }
  });

  router.post('/privacy/v1/status', async (req, res, next) => {
    try {
      const status = String(req.body && req.body.status || '');
      if (['cancelled', 'rejected'].includes(status)) {
        await pool.execute('UPDATE epos_privacy_requests SET status = ?, updated_at = NOW() WHERE request_id = ?', [status, String(req.body.request || '')]);
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/**
 * The member's own button, mounted on the loyalty router so it shares one
 * idea of a signed-in member (requireCustomer).
 */
function loyaltyDeletionRoutes({ pool, requireCustomer }) {
  const router = express.Router();

  async function current(office, customerId) {
    const [[row]] = await pool.query(
      `SELECT request_id, status, mode, delay_days, due_at, manage_url, created_at
         FROM epos_privacy_requests WHERE office = ? AND customer_id = ?
        ORDER BY created_at DESC LIMIT 1`,
      [office, customerId]
    );
    return row && ['scheduled', 'awaiting_review', 'needs_attention', 'processing'].includes(row.status) ? row : null;
  }

  function shape(row) {
    return row ? {
      id: row.request_id, status: row.status, mode: row.mode, delay_days: row.delay_days,
      due_at: row.due_at, manage_url: row.manage_url, requested_at: row.created_at,
    } : null;
  }

  router.get('/loyalty/v1/me/deletion', requireCustomer, async (req, res, next) => {
    try {
      res.json({ request: shape(await current(req.office, req.customerId)), day_choices: DAY_CHOICES });
    } catch (e) {
      next(e);
    }
  });

  router.post('/loyalty/v1/me/deletion', requireCustomer, async (req, res, next) => {
    try {
      if (!SECRET) return res.status(503).json({ error: 'Deleting from the app is not available yet. Use auth.vesopa.com/delete-account.' });
      const [[c]] = await pool.query(
        `SELECT c.id, c.email, c.phone, c.card_number, c.points_balance, c.created_at, a.slug, a.app_name
           FROM epos_customers c JOIN epos_loyalty_app a ON ${SAME_OFFICE}
          WHERE c.id = ? AND c.email_key = ?`,
        [req.customerId, req.office]
      );
      if (!c) return res.status(404).json({ error: 'We could not find your membership.' });

      const mode = req.body && req.body.mode === 'review' ? 'review' : 'scheduled';
      const days = DAY_CHOICES.includes(Number(req.body && req.body.delay_days)) ? Number(req.body.delay_days) : undefined;
      const phone = String(c.phone || '');
      const body = JSON.stringify({
        email: c.email || '',
        contact_label: c.email ? '' : phone ? `phone ending ${phone.slice(-3)} at ${c.app_name}` : `member at ${c.app_name}`,
        app_label: c.app_name || '',
        mode,
        delay_days: days,
        items: [{ reference: c.id, label: c.app_name || 'Loyalty membership', detail: describeMembership(c) }],
        ip: String(req.ip || '').replace(/^::ffff:/, ''),
        user_agent: String(req.get('user-agent') || '').slice(0, 255),
      });
      const response = await fetch(`${AUTH}/privacy/v1/requests`, {
        method: 'POST',
        headers: {
          'content-type': 'application/vesopa+json',
          'vesopa-application': APPLICATION,
          'vesopa-signature': sign(body),
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
      const answer = await response.json().catch(() => null);
      if (!response.ok || !answer || !answer.id) {
        console.error('[privacy] filing a request failed:', response.status, answer && answer.error);
        return res.status(502).json({ error: 'We could not send your request just now. Please try again, or use auth.vesopa.com/delete-account.' });
      }
      await pool.execute(
        `INSERT INTO epos_privacy_requests (office, customer_id, request_id, status, mode, delay_days, due_at, manage_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), mode = VALUES(mode), delay_days = VALUES(delay_days),
                                 due_at = VALUES(due_at), manage_url = COALESCE(VALUES(manage_url), manage_url), updated_at = NOW()`,
        [req.office, c.id, answer.id, answer.status, answer.mode, days || null,
          answer.due_at ? new Date(answer.due_at) : null, answer.manage_url || null]
      );
      res.status(201).json({ request: shape(await current(req.office, req.customerId)), existing: Boolean(answer.existing) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { privacyRoutes, loyaltyDeletionRoutes, eraseMembership };
