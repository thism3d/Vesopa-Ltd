/**
 * Signing in to a venue's menu with a code.
 *
 * WHY A CODE AND NOT A PASSWORD
 *
 * The person here is sitting at a table with food coming. They will not invent
 * and remember a password for a pub they are in once, and asking them to is how
 * a QR menu gets abandoned halfway through a basket. A code to an address or a
 * number proves the same thing — that they can receive at it — without leaving
 * them anything to forget.
 *
 * A password is offered afterwards, once, as a faster way back in. Most will
 * skip it, and skipping costs them nothing: the code works every time.
 *
 * TWO CHANNELS, TWO DIFFERENT MECHANISMS
 *
 * **Email** is ours end to end: we mint the code, hash it, send it from the
 * venue's own mailbox and check it here.
 *
 * **Phone** is Postcoder's. Their otp/send generates and sends it; their
 * otp/verify checks it. We never see the code, and there is nothing here that
 * could verify one offline. That is a deliberate boundary, not an omission —
 * the alternative is us holding an SMS gateway credential and a list of live
 * codes for the sake of symmetry.
 *
 * Postcoder's OTP service sends to UK mobiles only. The country picker is real
 * and its dial codes are real, but a non-UK number is refused here with a
 * sentence telling the customer to use email instead — which is better than an
 * SMS that silently never arrives.
 *
 * WHAT IS NEVER WRITTEN DOWN
 *
 * The code itself. `code_hash` is a SHA-256 over a per-row salt, and the
 * comparison is timing-safe. A one-time password table in clear is a list of
 * live credentials, and a leaked one is worse than a leaked password database
 * because nobody thinks of it as one.
 */

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { sendMail } = require('./mailer');

// How long a session lasts once a code has been checked. A month, as asked:
// long enough that a regular is not asked again, short enough that a phone
// left in a taxi stops being a way in.
const SESSION_DAYS = 30;

const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 10;

// Rate limits. Two of them, because they stop different things: the first stops
// somebody being used to send messages to a stranger, the second stops one
// machine walking through addresses. Phone sends also cost real money.
const MAX_SENDS_PER_DESTINATION = 4;      // per hour
const MAX_SENDS_PER_IP = 12;              // per hour
const MAX_ATTEMPTS = 5;                   // per challenge

const POSTCODER_BASE = 'https://ws.postcoder.com/pcw';

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------
//
// Not every country in the world: the ones a venue on this platform plausibly
// serves, with the United Kingdom first because that is where the venues are
// and because Postcoder will only text a UK mobile.
const COUNTRIES = [
  { code: 'GB', dial: '44', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'IE', dial: '353', name: 'Ireland', flag: '🇮🇪' },
  { code: 'US', dial: '1', name: 'United States', flag: '🇺🇸' },
  { code: 'CA', dial: '1', name: 'Canada', flag: '🇨🇦' },
  { code: 'AU', dial: '61', name: 'Australia', flag: '🇦🇺' },
  { code: 'NZ', dial: '64', name: 'New Zealand', flag: '🇳🇿' },
  { code: 'FR', dial: '33', name: 'France', flag: '🇫🇷' },
  { code: 'DE', dial: '49', name: 'Germany', flag: '🇩🇪' },
  { code: 'ES', dial: '34', name: 'Spain', flag: '🇪🇸' },
  { code: 'IT', dial: '39', name: 'Italy', flag: '🇮🇹' },
  { code: 'PT', dial: '351', name: 'Portugal', flag: '🇵🇹' },
  { code: 'NL', dial: '31', name: 'Netherlands', flag: '🇳🇱' },
  { code: 'BE', dial: '32', name: 'Belgium', flag: '🇧🇪' },
  { code: 'PL', dial: '48', name: 'Poland', flag: '🇵🇱' },
  { code: 'RO', dial: '40', name: 'Romania', flag: '🇷🇴' },
  { code: 'IN', dial: '91', name: 'India', flag: '🇮🇳' },
  { code: 'PK', dial: '92', name: 'Pakistan', flag: '🇵🇰' },
  { code: 'BD', dial: '880', name: 'Bangladesh', flag: '🇧🇩' },
  { code: 'NG', dial: '234', name: 'Nigeria', flag: '🇳🇬' },
  { code: 'ZA', dial: '27', name: 'South Africa', flag: '🇿🇦' },
  { code: 'AE', dial: '971', name: 'United Arab Emirates', flag: '🇦🇪' },
];

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

/** The default country, defaulting to the United Kingdom, as asked. */
const DEFAULT_COUNTRY = 'GB';

/**
 * Where the request looks like it came from.
 *
 * Read from whatever the edge put in front of us — Cloudflare and most CDNs
 * set one of these — and never guessed at. There is no IP database here and no
 * call out to one: a lookup service on the path of a page load is a third party
 * who learns every customer's address, for the sake of pre-selecting a dropdown
 * they can change in one tap.
 *
 * Falls back to the United Kingdom, which is both the sensible default for this
 * platform and the only country Postcoder will text.
 */
function countryFromRequest(req) {
  const headers = [
    'cf-ipcountry',            // Cloudflare
    'x-vercel-ip-country',
    'x-geo-country',
    'x-country-code',
  ];
  for (const name of headers) {
    const raw = String(req.headers[name] || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(raw) && BY_CODE.has(raw)) return raw;
  }
  return DEFAULT_COUNTRY;
}

// ---------------------------------------------------------------------------
// Normalising what was typed
// ---------------------------------------------------------------------------

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

function cleanEmail(raw) {
  const value = String(raw || '').trim().toLowerCase().slice(0, 190);
  return EMAIL.test(value) ? value : null;
}

/**
 * A phone number as E.164, or null.
 *
 * Normalised so the rate limit cannot be walked around by changing the spacing,
 * and so one person is one account however they type their own number. The
 * leading zero of a national number is dropped, which is the one rule that
 * catches almost everybody: 07700 900123 in the United Kingdom is +447700900123
 * and not +44 0 7700 900123.
 */
function cleanPhone(raw, countryCode) {
  const country = BY_CODE.get(String(countryCode || '').toUpperCase())
    || BY_CODE.get(DEFAULT_COUNTRY);
  let digits = String(raw || '').replace(/[^\d+]/g, '');
  if (!digits) return null;

  if (digits.startsWith('+')) {
    digits = digits.slice(1).replace(/\D/g, '');
  } else {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) digits = country.dial + digits.slice(1);
    else if (!digits.startsWith(country.dial)) digits = country.dial + digits;
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return '+' + digits;
}

/** Postcoder sends to UK mobiles only, so this is the gate for phone sign-in. */
function isUkMobile(e164) {
  return /^\+447\d{9}$/.test(String(e164 || ''));
}

// ---------------------------------------------------------------------------
// The code
// ---------------------------------------------------------------------------

/** Six digits, from the cryptographic generator, leading zeros kept. */
function newCode() {
  const max = 10 ** CODE_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(CODE_LENGTH, '0');
}

function hashCode(code, salt) {
  return crypto.createHash('sha256').update(salt + ':' + code).digest('hex');
}

/** Timing-safe, so a wrong code cannot be narrowed down by how long it took. */
function sameHash(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function newPublicId() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = {
  COUNTRIES,
  DEFAULT_COUNTRY,
  countryFromRequest,
  cleanEmail,
  cleanPhone,
  isUkMobile,
  newCode,
  hashCode,
  sameHash,
  dineinOtpRoutes,
};

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

function dineinOtpRoutes({ pool, secret }) {
  const router = express.Router();

  /** The office behind a table code or a venue slug, or null. */
  async function officeFor(body) {
    if (body && body.table) {
      const [[row]] = await pool.query(
        'SELECT office_id FROM floor_tables WHERE public_id = ?',
        [String(body.table)]
      );
      return row ? row.office_id : null;
    }
    if (body && body.slug) {
      const [[row]] = await pool.query(
        'SELECT office_id FROM dinein_venue WHERE slug = ? AND is_published = 1',
        [String(body.slug).toLowerCase()]
      );
      return row ? row.office_id : null;
    }
    return null;
  }

  function dinerToken(diner) {
    return jwt.sign(
      { scope: 'diner', diner: diner.id, office: diner.office_id },
      secret,
      { expiresIn: SESSION_DAYS + 'd' }
    );
  }

  const ipOf = (req) =>
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.ip || null;

  /**
   * What the sign-in form needs before it can draw itself: the countries, and
   * which one to start on.
   */
  router.get('/api/public/dinein/geo', (req, res) => {
    res.json({
      country: countryFromRequest(req),
      countries: COUNTRIES,
      // Said out loud so the page can tell somebody before they type, rather
      // than after they have waited for a message that is not coming.
      sms_countries: ['GB'],
    });
  });

  /**
   * Send a code.
   *
   * Answers the same whether or not an account exists, because this is sign-in
   * and sign-up in one — there is nothing to reveal.
   */
  router.post('/api/public/dinein/otp/send', async (req, res, next) => {
    try {
      const body = req.body || {};
      const officeId = await officeFor(body);
      if (officeId == null) {
        return res.status(404).json({ error: 'No venue at that address.' });
      }

      const channel = body.channel === 'phone' ? 'phone' : 'email';
      let destination = null;
      if (channel === 'email') {
        destination = cleanEmail(body.email);
        if (!destination) {
          return res.status(400).json({ error: 'That does not look like an email address.' });
        }
      } else {
        destination = cleanPhone(body.phone, body.country);
        if (!destination) {
          return res.status(400).json({ error: 'That does not look like a phone number.' });
        }
        if (!isUkMobile(destination)) {
          // Said plainly rather than attempted and lost. Postcoder texts UK
          // mobiles; anything else would be accepted here and never arrive.
          return res.status(400).json({
            error: 'We can only text UK mobile numbers at the moment. '
              + 'Please use your email address instead.',
            use_email: true,
          });
        }
        if (!process.env.POSTCODER_API_KEY) {
          return res.status(503).json({
            error: 'Text messages are not switched on here. Please use your email address.',
            use_email: true,
          });
        }
      }

      // --- the two rate limits ---------------------------------------------
      const ip = ipOf(req);
      const [[perDest]] = await pool.query(
        'SELECT COUNT(*) AS n FROM dinein_otp' +
          ' WHERE office_id = ? AND destination = ? AND created_at > NOW() - INTERVAL 1 HOUR',
        [officeId, destination]
      );
      if (perDest.n >= MAX_SENDS_PER_DESTINATION) {
        return res.status(429).json({
          error: 'That is a lot of codes. Please wait a little while before asking for another.',
        });
      }
      if (ip) {
        const [[perIp]] = await pool.query(
          'SELECT COUNT(*) AS n FROM dinein_otp' +
            ' WHERE ip = ? AND created_at > NOW() - INTERVAL 1 HOUR',
          [ip]
        );
        if (perIp.n >= MAX_SENDS_PER_IP) {
          return res.status(429).json({
            error: 'Too many codes from this connection. Please try again later.',
          });
        }
      }

      const publicId = newPublicId();
      let codeHash = null;
      let salt = null;
      let providerRef = null;

      if (channel === 'email') {
        const code = newCode();
        salt = crypto.randomBytes(16).toString('hex');
        codeHash = hashCode(code, salt);

        const venueName = await nameOf(officeId);
        const sent = await sendMail({
          to: destination,
          subject: `${code} is your ${venueName} code`,
          text: `${code} is your code for ${venueName}.\n\n`
            + `It works for ${CODE_TTL_MINUTES} minutes. If you did not ask for it, `
            + 'you can ignore this — nobody can use it without your inbox.\n',
          html: codeEmail(code, venueName),
          account: 'menu',
        });
        if (!sent) {
          return res.status(503).json({
            error: 'We could not send the code just now. Please try again in a moment.',
          });
        }
      } else {
        const venueName = await nameOf(officeId);
        providerRef = await postcoderSend(destination, venueName);
        if (!providerRef) {
          return res.status(503).json({
            error: 'We could not text that number just now. Please use your email address instead.',
            use_email: true,
          });
        }
      }

      await pool.execute(
        'INSERT INTO dinein_otp' +
          ' (public_id, office_id, channel, destination, code_hash, code_salt,' +
          '  provider_ref, expires_at, ip)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, NOW() + INTERVAL ? MINUTE, ?)',
        [publicId, officeId, channel, destination, codeHash, salt,
          providerRef, CODE_TTL_MINUTES, ip]
      );

      res.json({
        ok: true,
        challenge: publicId,
        channel,
        // Enough to say "we sent it to the address ending ...co.uk" without
        // printing the whole thing on a screen somebody else may be looking at.
        masked: mask(destination, channel),
        expires_in: CODE_TTL_MINUTES * 60,
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Check a code, and sign them in.
   *
   * Creates the account if there is not one. Signing in and signing up are the
   * same act here: proving you can receive at an address is the whole of it.
   */
  router.post('/api/public/dinein/otp/verify', async (req, res, next) => {
    try {
      const body = req.body || {};
      const [[challenge]] = await pool.query(
        'SELECT * FROM dinein_otp WHERE public_id = ?',
        [String(body.challenge || '')]
      );
      const wrong = { error: 'That code is not right, or it has expired.' };
      if (!challenge) return res.status(400).json(wrong);
      if (challenge.consumed_at) return res.status(400).json(wrong);
      if (new Date(challenge.expires_at).getTime() < Date.now()) {
        return res.status(400).json(wrong);
      }
      if (challenge.attempts >= MAX_ATTEMPTS) {
        return res.status(429).json({
          error: 'Too many tries. Ask for a new code.',
        });
      }

      // Counted before it is checked, so a crash or a race cannot hand somebody
      // a free guess.
      await pool.execute(
        'UPDATE dinein_otp SET attempts = attempts + 1 WHERE id = ?',
        [challenge.id]
      );

      const given = String(body.code || '').replace(/\D/g, '');
      let ok = false;
      if (challenge.channel === 'email') {
        ok = given.length === CODE_LENGTH
          && sameHash(hashCode(given, challenge.code_salt), challenge.code_hash);
      } else {
        ok = await postcoderVerify(challenge.provider_ref, given);
      }
      if (!ok) return res.status(400).json(wrong);

      await pool.execute(
        'UPDATE dinein_otp SET consumed_at = NOW() WHERE id = ?',
        [challenge.id]
      );

      const diner = await findOrCreate(
        challenge.office_id, challenge.channel, challenge.destination, body
      );

      res.json({
        ok: true,
        token: dinerToken(diner),
        account: {
          email: diner.email,
          phone: diner.phone_e164,
          name: diner.name,
          has_password: !!diner.pass_hash,
        },
        // The page uses this to decide whether to offer a password. Offered
        // once, to somebody who has just proved who they are and has not got
        // one; never nagged at afterwards.
        offer_password: !diner.pass_hash,
        is_new: !!diner.was_created,
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Add a password, or take one off.
   *
   * Entirely optional, and the code keeps working either way — this is a faster
   * way back in, not a second thing that has to be right.
   */
  router.post('/api/public/dinein/account/password', async (req, res, next) => {
    try {
      const who = dinerOf(req, secret);
      if (!who) return res.status(401).json({ error: 'Sign in first.' });

      const password = String((req.body || {}).password || '');
      if (password === '') {
        await pool.execute(
          'UPDATE dinein_diners SET pass_hash = NULL WHERE id = ? AND office_id = ?',
          [who.id, who.office]
        );
        return res.json({ ok: true, has_password: false });
      }
      // Length, and nothing else. Composition rules push people towards
      // Passw0rd! and away from three words they will actually remember.
      if (password.length < 8) {
        return res.status(400).json({ error: 'Use at least eight characters.' });
      }
      const hash = await bcrypt.hash(password, 10);
      await pool.execute(
        'UPDATE dinein_diners SET pass_hash = ? WHERE id = ? AND office_id = ?',
        [hash, who.id, who.office]
      );
      res.json({ ok: true, has_password: true });
    } catch (e) {
      next(e);
    }
  });

  /** Optional, and separate: a name is a courtesy, not a credential. */
  router.post('/api/public/dinein/account/name', async (req, res, next) => {
    try {
      const who = dinerOf(req, secret);
      if (!who) return res.status(401).json({ error: 'Sign in first.' });
      const name = String((req.body || {}).name || '').trim().slice(0, 120);
      await pool.execute(
        'UPDATE dinein_diners SET name = ? WHERE id = ? AND office_id = ?',
        [name || null, who.id, who.office]
      );
      res.json({ ok: true, name: name || null });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Helpers that need the pool
  // -------------------------------------------------------------------------

  async function nameOf(officeId) {
    const [[row]] = await pool.query(
      'SELECT COALESCE(NULLIF(TRIM(v.display_name), ""), o.name) AS name' +
        '  FROM dinein_venue v LEFT JOIN offices o ON o.id = v.office_id' +
        ' WHERE v.office_id = ?',
      [officeId]
    );
    return (row && row.name) || 'Vesopa';
  }

  /**
   * The account behind a proved address or number, made if there is not one.
   *
   * Matched on the channel that was proved, never on the other one: somebody
   * who proves a phone number must not be handed an account that happens to
   * carry an email they have not proved.
   */
  async function findOrCreate(officeId, channel, destination, body) {
    const column = channel === 'email' ? 'email' : 'phone_e164';
    const [[found]] = await pool.query(
      `SELECT * FROM dinein_diners WHERE office_id = ? AND ${column} = ?`,
      [officeId, destination]
    );
    const stamp = channel === 'email' ? 'email_verified_at' : 'phone_verified_at';

    if (found) {
      await pool.execute(
        `UPDATE dinein_diners SET last_seen = NOW(), ${stamp} = NOW() WHERE id = ?`,
        [found.id]
      );
      return found;
    }

    const name = String((body && body.name) || '').trim().slice(0, 120) || null;
    const [r] = await pool.execute(
      'INSERT INTO dinein_diners' +
        ` (office_id, ${column}, name, country, last_seen, ${stamp})` +
        ' VALUES (?, ?, ?, ?, NOW(), NOW())',
      [officeId, destination, name,
        (BY_CODE.get(String((body && body.country) || '').toUpperCase()) || {}).code || null]
    );
    const [[made]] = await pool.query('SELECT * FROM dinein_diners WHERE id = ?', [r.insertId]);
    if (made) made.was_created = true;
    return made;
  }

  return router;
}

// ---------------------------------------------------------------------------
// Postcoder
// ---------------------------------------------------------------------------

/**
 * Ask Postcoder to send a code, and give back the id it will check against.
 *
 * Returns null on any failure rather than throwing: a text that did not go is a
 * thing to tell the customer about, not a 500. What went wrong is logged here,
 * because the customer cannot act on it and the venue's support can.
 */
async function postcoderSend(e164, venueName) {
  const key = process.env.POSTCODER_API_KEY;
  if (!key) return null;
  try {
    // `from` is 3-11 GSM7 characters and `message` must contain [otp], which
    // Postcoder substitutes. 140 characters is the whole message.
    const sender = (process.env.POSTCODER_SENDER || 'Vesopa').slice(0, 11);
    const res = await fetch(
      `${POSTCODER_BASE}/${encodeURIComponent(key)}/otp/send?format=json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: e164,
          from: sender,
          message: `[otp] is your ${String(venueName).slice(0, 40)} code. `
            + 'It expires in 10 minutes.',
          otplength: CODE_LENGTH,
          expiry: CODE_TTL_MINUTES,
        }),
        signal: AbortSignal.timeout(12000),
      }
    );
    if (!res.ok) {
      console.warn('[otp] postcoder send refused:', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    return data && data.id ? String(data.id) : null;
  } catch (e) {
    console.warn('[otp] postcoder send failed:', e.message);
    return null;
  }
}

/** Postcoder answers 200 with `{ valid: true|false }` either way. */
async function postcoderVerify(id, code) {
  const key = process.env.POSTCODER_API_KEY;
  if (!key || !id) return false;
  try {
    const res = await fetch(
      `${POSTCODER_BASE}/${encodeURIComponent(key)}/otp/verify?format=json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: String(id), otp: String(code) }),
        signal: AbortSignal.timeout(12000),
      }
    );
    if (!res.ok) return false;
    const data = await res.json();
    return !!(data && data.valid === true);
  } catch (e) {
    console.warn('[otp] postcoder verify failed:', e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

/**
 * Who is asking, if anybody.
 *
 * The same shape as the one in dinein.js and for the same reason: an expired or
 * unreadable token means a guest, never an error.
 */
function dinerOf(req, secret) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  try {
    const claims = jwt.verify(header.slice(7), secret);
    if (claims.scope !== 'diner') return null;
    return { id: Number(claims.diner), office: Number(claims.office) };
  } catch {
    return null;
  }
}

/** Enough of it to recognise, not enough to read out. */
function mask(destination, channel) {
  const value = String(destination || '');
  if (channel === 'email') {
    const at = value.indexOf('@');
    if (at < 1) return value;
    const name = value.slice(0, at);
    const head = name.slice(0, Math.min(2, name.length));
    return head + '•'.repeat(Math.max(1, name.length - head.length)) + value.slice(at);
  }
  return value.slice(0, 3) + ' •••• ' + value.slice(-3);
}

/** The code, big enough to read off a lock screen. */
function codeEmail(code, venueName) {
  const safe = String(venueName).replace(/[<>&"]/g, '');
  return `<!doctype html><html><body style="margin:0;background:#F4F5F1;
  font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  color:#14161A">
  <div style="max-width:440px;margin:0 auto;padding:32px 20px">
    <div style="background:#fff;border-radius:16px;padding:28px 24px;text-align:center">
      <p style="margin:0 0 6px;color:#63696F;font-size:14px">Your code for</p>
      <h1 style="margin:0 0 22px;font-size:20px">${safe}</h1>
      <div style="font-size:38px;font-weight:700;letter-spacing:.22em;
                  background:#F4F5F1;border-radius:12px;padding:16px 8px">${code}</div>
      <p style="margin:20px 0 0;color:#63696F;font-size:14px">
        It works for ${CODE_TTL_MINUTES} minutes.
      </p>
    </div>
    <p style="margin:18px 0 0;color:#8A9099;font-size:13px;text-align:center">
      If you did not ask for this you can ignore it — nobody can use it without
      getting into your inbox.
    </p>
  </div></body></html>`;
}
