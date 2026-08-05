/**
 * Back-office password reset.
 *
 * Shape of the flow:
 *   1. POST /api/password/forgot  { email }
 *      Always answers 200 with the same body. Saying "no such account" here
 *      turns the endpoint into a free list of who banks with Vesopa.
 *   2. A single-use token is mailed as a link to BACKOFFICE_URL/reset?token=…
 *   3. POST /api/password/reset   { token, password }
 *      Verifies, bcrypts the new password, burns the token, and invalidates
 *      every other outstanding token for that user.
 *
 * Only the SHA-256 of the token is stored, so the table is useless to anyone
 * who reads it.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');

const { sendMail, mailEnabled } = require('./mailer');

// Long enough to walk to another device and short enough that a forwarded or
// archived email stops working the same day.
const TOKEN_TTL_MINUTES = 60;

// Matches the minlength on the sign-in form; the server is what actually
// enforces it, since the client can be bypassed.
const MIN_PASSWORD = 8;

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/**
 * Per-process throttle. pm2 runs this app as a single fork instance (see
 * ecosystem.config.cjs — cluster mode would break the WebSocket dispatcher),
 * so one map genuinely covers the whole service. If that ever becomes more
 * than one process this needs to move into the database.
 */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
// Per-address is tight: nobody needs six links for one account in a quarter of
// an hour. Per-IP is deliberately looser, because a whole office sits behind
// one NAT address and a shared limit of 5 would let one person lock out their
// colleagues.
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 20;

function throttled(key, max) {
  const now = Date.now();
  const hits = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  attempts.set(key, hits);

  // Opportunistic sweep, so a long-running process does not accumulate a key
  // for every address that ever asked.
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) {
      if (v.every((t) => now - t >= WINDOW_MS)) attempts.delete(k);
    }
  }

  return hits.length > max;
}

/** Where the emailed link points. Falls back to the request's own origin. */
function resetLink(req, token) {
  const base = (process.env.BACKOFFICE_URL || `${req.protocol}://${req.get('host')}`)
    .replace(/\/+$/, '');
  return `${base}/reset?token=${encodeURIComponent(token)}`;
}

function resetEmail({ name, link }) {
  const who = name ? `Hi ${name},` : 'Hi,';
  const text =
    `${who}\n\n` +
    `Someone asked to reset the password for your Vesopa Back Office account.\n\n` +
    `Open this link to choose a new one:\n${link}\n\n` +
    `The link works once and expires in ${TOKEN_TTL_MINUTES} minutes.\n\n` +
    `If this wasn't you, ignore this email — your password has not changed.\n\n` +
    `Vesopa EPOS`;

  const html = `
<div style="margin:0;padding:32px 16px;background:#f5f4f7;
            font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
            color:#17141c">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;
              border:1px solid #e6e3ea;padding:32px">
    <div style="font:750 24px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
                letter-spacing:-.02em;margin:0 0 26px">
      vesop<span style="color:#6e8a0e">a</span>
    </div>

    <h1 style="margin:0 0 10px;font-size:20px;font-weight:650;letter-spacing:-.02em">
      Reset your password
    </h1>
    <p style="margin:0 0 22px;color:#5a5462">
      ${who} someone asked to reset the password for your Vesopa Back Office
      account. Choose a new one below.
    </p>

    <!-- Lime is a light colour: white type on it lands near 1.9:1, so the
         button ink is the near-black used everywhere else on the brand. -->
    <a href="${link}"
       style="display:inline-block;background:#a5c715;color:#10130a;
              text-decoration:none;font-weight:650;font-size:15px;
              padding:13px 26px;border-radius:9px">
      Choose a new password
    </a>

    <p style="margin:22px 0 0;font-size:13px;color:#78717f">
      The link works once and expires in ${TOKEN_TTL_MINUTES} minutes.
      If this wasn't you, ignore this email — your password has not changed.
    </p>
    <p style="margin:18px 0 0;font-size:12px;color:#9c9c9a;word-break:break-all">
      If the button doesn't work, paste this into your browser:<br />${link}
    </p>
  </div>
</div>`;

  return { text, html };
}

function passwordRoutes({ pool }) {
  const router = express.Router();

  // ---- Request a link ----------------------------------------------------

  router.post('/password/forgot', async (req, res, next) => {
    const email = String(req.body?.email || '').trim().toLowerCase();

    // One body for every outcome — unknown address, throttled, mail down.
    const ok = () =>
      res.json({
        ok: true,
        message: 'If that email has a Back Office account, a reset link is on its way.',
      });

    if (!email || !email.includes('@')) return ok();
    if (throttled(`e:${email}`, MAX_PER_EMAIL) || throttled(`i:${req.ip}`, MAX_PER_IP)) {
      console.warn(`[reset] throttled request for ${email} from ${req.ip}`);
      return ok();
    }

    try {
      const [rows] = await pool.execute(
        `SELECT u.id, u.email, u.name, u.approved, o.status AS office_status, u.role
           FROM backoffice_users u
           LEFT JOIN offices o ON o.id = u.office_id
          WHERE u.email = ?`,
        [email]
      );

      const user = rows[0];
      // Unapproved accounts and paused offices cannot sign in, so handing them
      // a working reset link would only produce a password that is refused at
      // the door. Silently do nothing — the response is identical either way.
      const eligible =
        user &&
        user.approved === 'Y' &&
        (user.role === 'admin' || !user.office_status || user.office_status === 'active');

      if (!eligible) {
        console.warn(`[reset] no eligible account for ${email}`);
        return ok();
      }

      const raw = crypto.randomBytes(32).toString('hex');
      await pool.execute(
        `INSERT INTO backoffice_password_resets
           (user_id, token_hash, expires_at, requested_ip)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?)`,
        [user.id, hashToken(raw), TOKEN_TTL_MINUTES, req.ip?.slice(0, 45) || null]
      );

      const link = resetLink(req, raw);
      if (!mailEnabled()) {
        // Without this the operator has no way to tell a misconfigured mailbox
        // from an address that simply has no account.
        console.warn(`[reset] SMTP disabled — link for ${email}: ${link}`);
        return ok();
      }

      const { text, html } = resetEmail({ name: user.name, link });
      await sendMail({
        to: user.email,
        subject: 'Reset your Vesopa Back Office password',
        text,
        html,
      });
      return ok();
    } catch (e) {
      next(e);
    }
  });

  // ---- Check a link before showing the form ------------------------------

  // Lets the page say "this link has expired" up front rather than after the
  // user has typed a password twice.
  router.get('/password/reset', async (req, res, next) => {
    try {
      const [rows] = await pool.execute(
        `SELECT id FROM backoffice_password_resets
          WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()`,
        [hashToken(String(req.query.token || ''))]
      );
      res.json({ valid: rows.length > 0 });
    } catch (e) {
      next(e);
    }
  });

  // ---- Set the new password ---------------------------------------------

  router.post('/password/reset', async (req, res, next) => {
    const token = String(req.body?.token || '');
    const password = String(req.body?.password || '');

    if (password.length < MIN_PASSWORD) {
      return res
        .status(400)
        .json({ error: `Choose a password of at least ${MIN_PASSWORD} characters.` });
    }
    if (!token) return res.status(400).json({ error: 'This reset link is invalid.' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // FOR UPDATE so two submissions of the same link cannot both pass the
      // used_at check before either writes it.
      const [rows] = await conn.execute(
        `SELECT id, user_id FROM backoffice_password_resets
          WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()
          FOR UPDATE`,
        [hashToken(token)]
      );

      if (rows.length === 0) {
        await conn.rollback();
        return res
          .status(400)
          .json({ error: 'This reset link has expired or has already been used.' });
      }

      const { id, user_id: userId } = rows[0];
      const hash = await bcrypt.hash(password, 12);

      const [result] = await conn.execute(
        'UPDATE backoffice_users SET password = ? WHERE id = ?',
        [hash, userId]
      );
      if (result.affectedRows === 0) {
        // The account was deleted between the request and the click.
        await conn.rollback();
        return res.status(400).json({ error: 'This reset link is no longer valid.' });
      }

      await conn.execute(
        'UPDATE backoffice_password_resets SET used_at = NOW() WHERE id = ?',
        [id]
      );
      // Anything else outstanding for this user dies too: if the request was
      // an attacker's, their unused link must not survive the real owner's
      // reset.
      await conn.execute(
        `UPDATE backoffice_password_resets SET used_at = NOW()
          WHERE user_id = ? AND used_at IS NULL`,
        [userId]
      );

      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback().catch(() => {});
      next(e);
    } finally {
      conn.release();
    }
  });

  return router;
}

module.exports = { passwordRoutes, MIN_PASSWORD };
