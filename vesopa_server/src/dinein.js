const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { requireAuth, requireTerminal } = require('./auth');

// ---------------------------------------------------------------------------
// Branding, offers and promotions
// ---------------------------------------------------------------------------

/** Vesopa's own colours, and what a venue that has set nothing gets. */
const THEME_DEFAULT = Object.freeze({
  accent: '#A5C715',
  onAccent: '#10130A',
  page: '#FFFFFF',
  card: '#FFFFFF',
  ink: '#14171C',
  inkSoft: '#5C6470',
  radius: 16,
  font: 'system',
});

/** JSON that never throws. A corrupt draft must not take the editor down. */
function safeJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const FONTS = new Set(['system', 'serif', 'rounded', 'mono']);

/**
 * A palette that is safe to put in a stylesheet.
 *
 * Every colour is checked against a six-digit hex and thrown away if it is not
 * one. These values are interpolated into a <style> block on a public page, so
 * anything that is not a colour is a way of writing CSS into somebody else's
 * menu — and the venue that types it is not necessarily the venue that ends up
 * reading it.
 */
function cleanTheme(raw) {
  let given = raw;
  if (typeof given === 'string' && given.trim()) {
    try { given = JSON.parse(given); } catch { given = null; }
  }
  if (!given || typeof given !== 'object') return { ...THEME_DEFAULT };

  const out = { ...THEME_DEFAULT };
  for (const key of ['accent', 'onAccent', 'page', 'card', 'ink', 'inkSoft']) {
    if (HEX.test(String(given[key] || ''))) out[key] = String(given[key]).toUpperCase();
  }
  const radius = Number(given.radius);
  if (Number.isFinite(radius)) out.radius = Math.max(0, Math.min(28, Math.round(radius)));
  if (FONTS.has(String(given.font))) out.font = String(given.font);
  return out;
}

/** At most six, each with a title. A promotion with no title is a gap. */
function cleanPromotions(raw) {
  let given = raw;
  if (typeof given === 'string' && given.trim()) {
    try { given = JSON.parse(given); } catch { given = null; }
  }
  if (!Array.isArray(given)) return [];
  return given
    .map((p) => ({
      title: String((p && p.title) || '').trim().slice(0, 80),
      body: String((p && p.body) || '').trim().slice(0, 240),
      image_url: String((p && p.image_url) || '').trim().slice(0, 500),
      until: /^\d{4}-\d{2}-\d{2}$/.test(String((p && p.until) || '')) ? p.until : null,
    }))
    .filter((p) => p.title)
    .slice(0, 6);
}

/**
 * The venue's offer, as the page needs to state it.
 *
 * Returns null when there is nothing on, so the page can ask one question
 * rather than three.
 */
function offerOf(venue) {
  if (!venue || !venue.offer_active) return null;
  const percent = Math.max(0, Math.min(90, Number(venue.offer_percent) || 0));
  if (!percent) return null;
  const min = Math.max(0, Number(venue.offer_min_spend_minor) || 0);
  return {
    percent,
    min_spend_minor: min,
    label: (venue.offer_label || '').trim() || null,
  };
}

/**
 * What an offer takes off a basket.
 *
 * Rounded down to the penny, and only once the basket has reached the minimum.
 * Computed in one place because the page quotes it and the order stores it, and
 * those two disagreeing is a customer being charged something they were not
 * shown.
 */
function discountFor(offer, subtotalMinor) {
  if (!offer) return 0;
  if (subtotalMinor < offer.min_spend_minor) return 0;
  return Math.floor((subtotalMinor * offer.percent) / 100);
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday'];

/** A day with no usable hours in it. */
const SHUT = Object.freeze({ closed: true, open: '09:00', close: '17:00' });

function cleanTime(value, fallback) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(value == null ? '' : value));
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return String(h).padStart(2, '0') + ':' + m[2];
}

/**
 * Seven days, Monday first, whatever was stored.
 *
 * Anything unreadable becomes "open all week", never "closed all week". A
 * venue whose hours JSON has been corrupted should keep taking orders and look
 * wrong, rather than stop taking orders and look fine — the first is noticed in
 * minutes and the second is noticed in a week of missing covers.
 */
function parseHours(raw) {
  let list = null;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { list = JSON.parse(raw); } catch { list = null; }
  }
  const out = [];
  for (let d = 0; d < 7; d += 1) {
    const row = (Array.isArray(list) && list[d]) || null;
    if (!row) {
      out.push({ closed: false, open: '09:00', close: '23:00' });
      continue;
    }
    out.push({
      closed: !!row.closed,
      open: cleanTime(row.open, '09:00'),
      close: cleanTime(row.close, '23:00'),
    });
  }
  return out;
}

/** Minutes since midnight, or null. */
function minutesOf(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The venue's own wall clock.
 *
 * Computed on the server on purpose. A phone in a pub can be an hour out, on
 * the wrong timezone, or deliberately set forward, and "are you open" is a
 * question the venue answers rather than the customer's device.
 */
function venueNow(timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'Europe/London',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (type) => (parts.find((x) => x.type === type) || {}).value;
  const short = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  // 24 is what en-GB calls midnight in hour12:false.
  const hour = Number(get('hour')) % 24;
  return {
    day: short[get('weekday')] ?? 0,
    minutes: hour * 60 + Number(get('minute')),
  };
}

/**
 * Is this venue open, and if not, when is it next.
 *
 * A close earlier than an open means the venue runs past midnight — 18:00 to
 * 01:00 is one shift, not a nineteen-hour closure — so that day's window is
 * read as running into the next.
 */
function openState(venue) {
  const hours = parseHours(venue && venue.opening_hours);
  const enabled = !venue || venue.schedule_enabled == null
    ? true
    : !!venue.schedule_enabled;

  if (!enabled) {
    return { enforced: false, open: true, hours, today: null, next: null };
  }

  const now = venueNow(venue && venue.timezone);
  const within = (dayIndex, atMinutes) => {
    const day = hours[dayIndex];
    if (!day || day.closed) return false;
    const from = minutesOf(day.open);
    const to = minutesOf(day.close);
    if (from == null || to == null) return false;
    if (to > from) return atMinutes >= from && atMinutes < to;
    // Runs past midnight, and only the evening half of it belongs to this day.
    //
    // The tail — midnight to the close — is the *previous* day's shift still
    // running, and it is `spill` below that owns it. Answering true for both
    // halves here counted it twice: a venue open Wednesday 18:00-01:00 was
    // reported open at half past midnight on Wednesday *morning*, sixteen hours
    // before that shift starts, even when Tuesday was marked closed.
    return atMinutes >= from;
  };

  // Yesterday's late shift can still be running: at 00:30 on Saturday the
  // thing that is open is Friday's 18:00-01:00, and Saturday's own window has
  // not started. Checked directly rather than by feeding tomorrow's clock into
  // `within`, which happened to give the right answer for the wrong reason.
  const yesterday = (now.day + 6) % 7;
  const spill = (() => {
    const day = hours[yesterday];
    if (!day || day.closed) return false;
    const from = minutesOf(day.open);
    const to = minutesOf(day.close);
    if (from == null || to == null) return false;
    if (to > from) return false;          // did not run past midnight
    return now.minutes < to;              // still inside the tail of it
  })();

  const openNow = within(now.day, now.minutes) || spill;

  let next = null;
  if (!openNow) {
    for (let ahead = 0; ahead < 8 && !next; ahead += 1) {
      const d = (now.day + ahead) % 7;
      const day = hours[d];
      if (!day || day.closed) continue;
      const from = minutesOf(day.open);
      if (from == null) continue;
      if (ahead === 0 && from <= now.minutes) continue;
      next = { day: DAYS[d], today: ahead === 0, at: day.open };
    }
  }

  return {
    enforced: true,
    open: !!openNow,
    hours,
    today: {
      day: DAYS[now.day],
      closed: !!hours[now.day].closed,
      open: hours[now.day].open,
      close: hours[now.day].close,
    },
    next,
  };
}

/**
 * Dine-in: the menu a customer reads off their own phone, and the orders they
 * place from it.
 *
 * THE SHAPE OF THE THING
 *
 * A code is printed and stood on a table. A customer points a phone at it and
 * lands on `/t/<public_id>` — a page that knows which venue and which table it
 * is without asking. They read the menu, build a basket, optionally leave a
 * name and a number, and send it. The till is told over the socket it already
 * holds open, a clerk accepts it, and from that moment it is an ordinary sale
 * against that table: it prints in the kitchen, it appears on the bill, and it
 * is settled at the counter like everything else.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * **Payment.** The venue asked for none yet and there is a good reason to be
 * glad of that: taking money for food nobody has accepted is the one way this
 * feature could cost a venue real money rather than a plate. The lifecycle
 * below leaves the seam for it — an order carries a total from the moment it is
 * placed — but nothing collects.
 *
 * **A customer account.** Name and number are optional and are not a login.
 * Somebody sitting at a table has already proved the only thing that matters,
 * which is that they are at the table.
 *
 * THREE AUDIENCES, THREE KINDS OF ROUTE
 *
 *   * `/api/dinein/*`      — the back office. Signed in, tenanted, and the only
 *                            place any of this is configured.
 *   * `/api/public/dinein/*` — the customer's phone. No credential but the
 *                            table's own id, which is what possession of the
 *                            printed card means.
 *   * `/till/dinein/*`     — the till. Reads what is waiting and moves it
 *                            through the lifecycle.
 *
 * They are one file because they are one feature and the rules that connect
 * them — what "published" means, what a customer may see, what an order may
 * become — belong next to each other rather than three modules apart.
 *
 * WHY THE PATHS ARE WRITTEN OUT IN FULL
 *
 * Because two of the three audiences live at different mount points and the
 * third has to match the platform's existing convention. Every other route a
 * till calls — `/till/products`, `/till/open-bills`, `/till/clock` — is at the
 * root, so a till's dine-in route has to be too. Mounted under `/api` with the
 * rest, it answered `/api/till/dinein/orders`, the till asked for
 * `/till/dinein/orders`, got the back office's 404 page, and the notification
 * badge stayed empty on a till with an order waiting on it.
 *
 * So this router states its own full paths and is mounted at the root, the same
 * way `cards.js` and `devices.js` do for the same reason.
 */
function dineinRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  /**
   * The till's own credential, which is not a session.
   *
   * `requireAuth` deliberately refuses a terminal token and `requireTerminal`
   * refuses a session one — a terminal token sits on a shop-floor machine and
   * must not open the back office. So the two `/till/dinein/*` routes below
   * take the terminal credential, and everything else takes a session.
   *
   * A terminal token carries `office` (the contact email) and `officeId`, but
   * not the `user` shape the rest of this file reads, so those routes resolve
   * their office through [terminalOffice] rather than [officeOf].
   */
  const terminal = requireTerminal(secret);

  // -------------------------------------------------------------------------
  // Small shared pieces
  // -------------------------------------------------------------------------

  /** 32 hex characters. The address of a table, or of an order. */
  const newPublicId = () => crypto.randomUUID().replace(/-/g, '');

  /**
   * Which office this signed-in request belongs to.
   *
   * The same rule the floor plan follows: an office user is pinned to their
   * own, and an admin has to name one. Returning null for an unnamed admin is
   * what makes every write below refuse rather than create an orphan row —
   * which is the fault schema_layout_floor_tenancy.sql exists to clean up.
   */
  async function officeOf(req) {
    if (req.user.officeId) return req.user.officeId;
    if (req.user.role !== 'admin') return null;
    if (req.query.office_id) return Number(req.query.office_id);
    if (req.body && req.body.office_id) return Number(req.body.office_id);

    const email = (req.query.office_email) || (req.body && req.body.office_email);
    if (email) {
      const [[office]] = await pool.query(
        'SELECT id FROM offices WHERE contact_email = ?',
        [email]
      );
      if (office) return office.id;
    }
    return null;
  }

  /** The office's contact email, which is what the catalogue is tenanted on. */
  async function emailOf(officeId) {
    const [[office]] = await pool.query(
      'SELECT contact_email FROM offices WHERE id = ?',
      [officeId]
    );
    return office ? office.contact_email : null;
  }

  /**
   * A venue's web address, cleaned into something that can live in a URL.
   *
   * Lower case, letters digits and hyphens, no leading or trailing hyphen, no
   * run of two. Rejected rather than silently mangled when nothing usable is
   * left: a manager who typed "The Bridge!!" should be told the address will be
   * `the-bridge`, not discover it later on a printed card.
   */
  function cleanSlug(raw) {
    const slug = String(raw || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/g, '');
    return slug;
  }

  /**
   * Addresses the platform needs for itself.
   *
   * A venue that claimed `api` or `assets` would shadow a real path the moment
   * the public router is mounted at the root, and the failure would look like
   * the back office breaking rather than like a slug being wrong.
   */
  const RESERVED = new Set([
    'api', 'admin', 'assets', 'uploads', 'health', 'ws', 'login', 'logout',
    'menu', 't', 'm', 'o', 'order', 'orders', 'wallet', 'pass', 'passes',
    'static', 'public', 'app', 'www', 'help', 'support', 'about', 'terms',
    'privacy', 'kitchen', 'till', 'display', 'dinein', 'qr',
  ]);

  /** The venue record, created empty on first read so the editor has a row. */
  async function venueRow(officeId) {
    const [[row]] = await pool.query(
      'SELECT * FROM dinein_venue WHERE office_id = ?',
      [officeId]
    );
    if (row) return row;

    await pool.execute(
      'INSERT IGNORE INTO dinein_venue (office_id) VALUES (?)',
      [officeId]
    );
    const [[fresh]] = await pool.query(
      'SELECT * FROM dinein_venue WHERE office_id = ?',
      [officeId]
    );
    return fresh || null;
  }

  // -------------------------------------------------------------------------
  // Back office: the venue's public face
  // -------------------------------------------------------------------------

  router.get('/api/dinein/venue', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Choose an office first.' });
      }
      const venue = await venueRow(officeId);
      const [[office]] = await pool.query(
        'SELECT name FROM offices WHERE id = ?',
        [officeId]
      );
      res.json({
        ...venue,
        // Always in a known shape, so the editor never has to think about a
        // venue that has set none of this yet.
        theme: cleanTheme(venue.theme_json),
        promotions: cleanPromotions(venue.promotions),
        offer: offerOf(venue),
        draft: venue.draft_json ? safeJson(venue.draft_json) : null,
        // Always seven days in a known shape, so the editor never has to think
        // about a venue that has not set any hours yet.
        opening_hours: parseHours(venue.opening_hours),
        open_state: openState(venue),
        // What the page would be called if nothing has been set. Sent rather
        // than defaulted into the column, so a venue that later renames its
        // account is not stuck with the old name frozen into its menu.
        fallback_name: office ? office.name : '',
        // The address a customer would reach this menu at.
        //
        // The editor used to take this off whatever page happened to have
        // loaded it last, which in practice was the Table codes page — so on a
        // fresh visit to the settings page the address shown under "Your web
        // address", the preview frame and the "Open the menu page" link were
        // all built from the back office's own origin. A manager reading the
        // hint was told to print backoffice.vesopaepos.com on their cards.
        base: publicBase(req, venue),
      });
    } catch (e) {
      next(e);
    }
  });

  router.put('/api/dinein/venue', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Choose an office first.' });
      }
      await venueRow(officeId);

      const body = req.body || {};
      const sets = [];
      const params = [];

      if (body.slug !== undefined) {
        const slug = cleanSlug(body.slug);
        if (!slug) {
          return res.status(400).json({
            error: 'That address has no letters or numbers in it.',
          });
        }
        if (slug.length < 3) {
          return res.status(400).json({
            error: 'A web address needs at least three characters.',
          });
        }
        if (RESERVED.has(slug)) {
          return res.status(409).json({
            error: 'That address is reserved. Try adding your town to it.',
          });
        }
        const [[taken]] = await pool.query(
          'SELECT office_id FROM dinein_venue WHERE slug = ? AND office_id <> ?',
          [slug, officeId]
        );
        if (taken) {
          return res.status(409).json({
            error: 'Another venue already uses that address.',
          });
        }
        sets.push('slug = ?');
        params.push(slug);
      }

      const plain = [
        'display_name', 'tagline', 'phone', 'address_line', 'postcode',
        'map_url', 'logo_url', 'banner_url', 'accent_colour', 'notice',
        'closed_message', 'offer_label', 'popular_title', 'featured_title',
      ];
      for (const field of plain) {
        if (body[field] === undefined) continue;
        sets.push(field + ' = ?');
        const value = String(body[field]).trim();
        params.push(value === '' ? null : value);
      }

      const flags = [
        'is_published', 'ordering_open', 'require_name', 'require_phone',
        'schedule_enabled', 'offer_active', 'show_popular', 'show_featured',
      ];
      for (const field of flags) {
        if (body[field] === undefined) continue;
        sets.push(field + ' = ?');
        params.push(body[field] ? 1 : 0);
      }

      if (body.eta_minutes !== undefined) {
        // Half an hour either side of sensible. Zero means "we do not say",
        // and four hours is somebody who has typed the wrong box.
        const eta = Math.max(0, Math.min(240, parseInt(body.eta_minutes, 10) || 0));
        sets.push('eta_minutes = ?');
        params.push(eta);
      }

      if (body.offer_percent !== undefined) {
        // Ninety per cent is where a discount stops being a discount and
        // becomes a mistake somebody made with a keyboard.
        sets.push('offer_percent = ?');
        params.push(Math.max(0, Math.min(90, parseInt(body.offer_percent, 10) || 0)));
      }
      if (body.offer_min_spend_minor !== undefined) {
        sets.push('offer_min_spend_minor = ?');
        params.push(Math.max(0, parseInt(body.offer_min_spend_minor, 10) || 0));
      }
      if (body.promotions !== undefined) {
        sets.push('promotions = ?');
        params.push(JSON.stringify(cleanPromotions(body.promotions)));
      }
      if (body.theme !== undefined) {
        sets.push('theme_json = ?');
        params.push(JSON.stringify(cleanTheme(body.theme)));
      }

      if (body.custom_domain !== undefined) {
        // Host headers carry no scheme, no port and no path, and that is what
        // this is matched against — so anything of that shape is stripped
        // rather than stored and quietly never matching.
        const host = String(body.custom_domain || '')
          .trim().toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/[/?#].*$/, '')
          .replace(/:\d+$/, '')
          .replace(/\.$/, '');
        if (host && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
          return res.status(400).json({ error: 'That does not look like a domain name.' });
        }
        if (host) {
          const [[taken]] = await pool.query(
            'SELECT office_id FROM dinein_venue WHERE custom_domain = ? AND office_id <> ?',
            [host, officeId]
          );
          if (taken) {
            return res.status(409).json({
              error: 'Another venue has already claimed that domain.',
            });
          }
        }
        sets.push('custom_domain = ?', 'domain_verified = ?');
        params.push(host || null, 0);
      }

      if (body.opening_hours !== undefined) {
        // Normalised on the way in, so that whatever is read back out is seven
        // days in a known shape whoever wrote it.
        sets.push('opening_hours = ?');
        params.push(JSON.stringify(parseHours(body.opening_hours)));
      }

      if (!sets.length) return res.json({ ok: true, changed: 0 });

      await pool.execute(
        'UPDATE dinein_venue SET ' + sets.join(', ') + ' WHERE office_id = ?',
        [...params, officeId]
      );
      broadcast({ type: 'dinein.updated' });
      res.json({ ok: true, venue: await venueRow(officeId) });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Whether an address is free, for the editor to ask as it is typed.
   *
   * Answers the cleaned form as well as the verdict, because the commonest
   * outcome is that the address is available *and* is not quite what was typed
   * — and a manager should see "the-bridge" before they save, not after.
   */
  /**
   * Keep a draft of the menu page without publishing it.
   *
   * A separate column from the live row, because the live row is what somebody
   * standing at a table is reading right now. A venue trying a new colour at
   * four in the afternoon must not be able to publish it by pressing the wrong
   * button, and must be able to come back to it tomorrow.
   */
  router.put('/api/dinein/draft', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Choose an office first.' });
      }
      await venueRow(officeId);
      await pool.execute(
        'UPDATE dinein_venue SET draft_json = ?, draft_saved_at = NOW() WHERE office_id = ?',
        [JSON.stringify(req.body || {}), officeId]
      );
      res.json({ ok: true, saved_at: new Date().toISOString() });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/api/dinein/draft', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Choose an office first.' });
      }
      await pool.execute(
        'UPDATE dinein_venue SET draft_json = NULL, draft_saved_at = NULL WHERE office_id = ?',
        [officeId]
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.get('/api/dinein/slug-check', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      const slug = cleanSlug(req.query.slug);
      if (!slug || slug.length < 3) {
        return res.json({ slug, ok: false, reason: 'Too short.' });
      }
      if (RESERVED.has(slug)) {
        return res.json({ slug, ok: false, reason: 'That address is reserved.' });
      }
      const [[taken]] = await pool.query(
        'SELECT office_id FROM dinein_venue WHERE slug = ?',
        [slug]
      );
      if (taken && taken.office_id !== officeId) {
        return res.json({ slug, ok: false, reason: 'Already taken.' });
      }
      res.json({ slug, ok: true });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Back office: the menu
  // -------------------------------------------------------------------------

  router.get('/api/dinein/menu', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Choose an office first.' });
      }
      const [sections] = await pool.query(
        'SELECT * FROM dinein_sections WHERE office_id = ? ORDER BY sort_order, id',
        [officeId]
      );
      // The catalogue's own name comes with each dish, as a placeholder for the
      // menu name. The editor used to show the PLU there — "PLU 1042" — which
      // is what the till calls it and means nothing to somebody writing a menu.
      // What they want to see is what the product is already called.
      const email = await emailOf(officeId);
      const [items] = await pool.query(
        'SELECT i.*, p.product_name AS catalogue_name' +
          '  FROM dinein_items i' +
          '  LEFT JOIN bo_products p ON p.email = ? AND p.pluid = i.plu_id' +
          ' WHERE i.office_id = ? ORDER BY i.sort_order, i.id',
        [email, officeId]
      );
      res.json(
        sections.map((s) => ({
          ...s,
          items: items.filter((i) => i.section_id === s.id),
        }))
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/api/dinein/sections', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Choose an office first.' });
      }
      const b = req.body || {};
      const [r] = await pool.execute(
        'INSERT INTO dinein_sections (office_id, name, blurb, image_url, sort_order)' +
          ' VALUES (?, ?, ?, ?, ?)',
        [
          officeId,
          String(b.name || 'New section').trim().slice(0, 120),
          b.blurb ? String(b.blurb).slice(0, 300) : null,
          b.image_url ? String(b.image_url).slice(0, 500) : null,
          Number(b.sort_order) || 0,
        ]
      );
      broadcast({ type: 'dinein.updated' });
      res.status(201).json({ id: r.insertId });
    } catch (e) {
      next(e);
    }
  });

  router.put('/api/dinein/sections/:id', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      const b = req.body || {};
      const sets = [];
      const params = [];
      for (const field of ['name', 'blurb', 'image_url']) {
        if (b[field] === undefined) continue;
        sets.push(field + ' = ?');
        const value = String(b[field]).trim();
        params.push(value === '' ? null : value);
      }
      for (const field of ['sort_order']) {
        if (b[field] === undefined) continue;
        sets.push(field + ' = ?');
        params.push(Number(b[field]) || 0);
      }
      if (b.active !== undefined) {
        sets.push('active = ?');
        params.push(b.active ? 1 : 0);
      }
      if (!sets.length) return res.json({ ok: true, changed: 0 });

      const [r] = await pool.execute(
        'UPDATE dinein_sections SET ' + sets.join(', ') + ' WHERE id = ?' +
          (officeId == null ? '' : ' AND office_id = ?'),
        officeId == null
          ? [...params, req.params.id]
          : [...params, req.params.id, officeId]
      );
      if (!r.affectedRows) {
        return res.status(404).json({ error: 'Section not found.' });
      }
      broadcast({ type: 'dinein.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/api/dinein/sections/:id', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      const [r] = await pool.execute(
        'DELETE FROM dinein_sections WHERE id = ?' +
          (officeId == null ? '' : ' AND office_id = ?'),
        officeId == null ? [req.params.id] : [req.params.id, officeId]
      );
      if (!r.affectedRows) {
        return res.status(404).json({ error: 'Section not found.' });
      }
      broadcast({ type: 'dinein.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Put products onto a section, several at a time.
   *
   * A batch because that is how the job is actually done: a manager opens the
   * catalogue beside the section, ticks nine starters and presses Add. Nine
   * round trips would each be a separate failure to recover from, and the
   * partial result — four starters on the menu — is worse than either outcome.
   */
  router.post('/api/dinein/sections/:id/items', auth, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const officeId = await officeOf(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Choose an office first.' });
      }
      const [[section]] = await conn.query(
        'SELECT id, office_id FROM dinein_sections WHERE id = ?',
        [req.params.id]
      );
      if (!section || section.office_id !== officeId) {
        return res.status(404).json({ error: 'Section not found.' });
      }

      const plus = Array.isArray(req.body.plu_ids)
        ? req.body.plu_ids
        : [req.body.plu_id];
      const wanted = plus
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (!wanted.length) {
        return res.status(400).json({ error: 'Nothing to add.' });
      }

      // Only products this venue actually owns. Without this a crafted request
      // could put another venue's PLU on a menu, and the price the customer
      // then saw would be read from a catalogue that is not theirs.
      const email = await emailOf(officeId);
      const [owned] = await conn.query(
        'SELECT pluid AS plu_id, product_name FROM bo_products' +
          ' WHERE email = ? AND pluid IN (' +
          wanted.map(() => '?').join(',') + ')',
        [email, ...wanted]
      );
      if (!owned.length) {
        return res.status(400).json({ error: 'None of those products are yours.' });
      }

      const [[last]] = await conn.query(
        'SELECT COALESCE(MAX(sort_order), 0) AS top FROM dinein_items WHERE section_id = ?',
        [section.id]
      );

      await conn.beginTransaction();
      let order = last.top;
      let added = 0;
      for (const product of owned) {
        order += 1;
        const [r] = await conn.execute(
          'INSERT INTO dinein_items (section_id, office_id, plu_id, name, sort_order)' +
            ' VALUES (?, ?, ?, ?, ?)',
          [section.id, officeId, product.plu_id, product.product_name, order]
        );
        if (r.affectedRows) added += 1;
      }
      await conn.commit();

      broadcast({ type: 'dinein.updated' });
      res.status(201).json({ ok: true, added });
    } catch (e) {
      await conn.rollback().catch(() => {});
      next(e);
    } finally {
      conn.release();
    }
  });

  router.put('/api/dinein/items/:id', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      const b = req.body || {};
      const sets = [];
      const params = [];
      for (const field of ['name', 'description', 'image_url', 'diet_tag']) {
        if (b[field] === undefined) continue;
        sets.push(field + ' = ?');
        const value = String(b[field]).trim();
        params.push(value === '' ? null : value);
      }
      for (const flag of ['is_popular', 'is_featured']) {
        if (b[flag] === undefined) continue;
        sets.push(flag + ' = ?');
        params.push(b[flag] ? 1 : 0);
      }
      if (b.sort_order !== undefined) {
        sets.push('sort_order = ?');
        params.push(Number(b.sort_order) || 0);
      }
      if (b.available !== undefined) {
        sets.push('available = ?');
        params.push(b.available ? 1 : 0);
      }
      if (b.section_id !== undefined) {
        sets.push('section_id = ?');
        params.push(Number(b.section_id));
      }
      if (!sets.length) return res.json({ ok: true, changed: 0 });

      const [r] = await pool.execute(
        'UPDATE dinein_items SET ' + sets.join(', ') + ' WHERE id = ?' +
          (officeId == null ? '' : ' AND office_id = ?'),
        officeId == null
          ? [...params, req.params.id]
          : [...params, req.params.id, officeId]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'Item not found.' });
      broadcast({ type: 'dinein.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/api/dinein/items/:id', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      const [r] = await pool.execute(
        'DELETE FROM dinein_items WHERE id = ?' +
          (officeId == null ? '' : ' AND office_id = ?'),
        officeId == null ? [req.params.id] : [req.params.id, officeId]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'Item not found.' });
      broadcast({ type: 'dinein.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Back office: the tables, and what to print for them
  // -------------------------------------------------------------------------

  /**
   * Every table with a public address, and the link that opens it.
   *
   * The link is built here rather than in the browser so that one place decides
   * what a table URL looks like. It is going onto a laminated card; a second
   * opinion about its shape is the last thing this needs.
   */
  router.get('/api/dinein/tables', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Choose an office first.' });
      }
      const venue = await venueRow(officeId);
      const [tables] = await pool.query(
        'SELECT t.id, t.room_id, t.table_number, t.name, t.label, t.public_id,' +
          '       t.qr_enabled, t.seats, r.name AS room_name' +
          '  FROM floor_tables t' +
          '  LEFT JOIN floor_rooms r ON r.id = t.room_id' +
          ' WHERE t.office_id = ?' +
          ' ORDER BY r.sort_order, r.id, t.table_number',
        [officeId]
      );
      // The venue's own domain once it answers on one, so the address printed
      // on a card and the address shown in the panel are the same address.
      const base = publicBase(req, venue);
      res.json({
        base,
        slug: venue ? venue.slug : null,
        custom_domain: venue ? venue.custom_domain || null : null,
        domain_verified: venue ? !!venue.domain_verified : false,
        tables: tables.map((t) => ({
          ...t,
          display_name: tableName(t),
          url: t.public_id ? base + '/t/' + t.public_id : null,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * What a table is called on a customer's phone.
   *
   * The name if the venue set one, the label if not, and "Table 7" as the last
   * resort — because a table has to be called *something* on a screen somebody
   * is about to carry food towards.
   */
  function tableName(t) {
    const name = (t.name || '').trim();
    if (name) return name;
    const label = (t.label || '').trim();
    if (label) return label;
    return 'Table ' + t.table_number;
  }

  /**
   * The address this server is reachable at, from the request that arrived.
   *
   * Behind nginx, so `X-Forwarded-Proto` and `X-Forwarded-Host` are what say
   * how the customer got here; falling back to the socket's own view would
   * print `http://127.0.0.1:3000` onto a card.
   */
  function publicBase(req, venue) {
    // A venue that owns a domain and has pointed it here gets its own address on
    // its own cards. Only once it has actually answered on that name: printing
    // a hundred cards against a DNS record that was never made is a hundred
    // tables that cannot order, and the flag is set by a real request arriving
    // rather than by somebody typing it into a form — see venueForHost in
    // dinein_pages.js.
    if (venue && venue.custom_domain && venue.domain_verified) {
      return 'https://' + venue.custom_domain;
    }

    // PUBLIC_BASE_URL is the menu host — menu.vesopaepos.com — and not the host
    // this request happened to arrive on. A card generated by a manager sitting
    // in the back office must carry the address a customer will scan, not the
    // address of the office they generated it from.
    const configured = (process.env.PUBLIC_BASE_URL || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    return String(proto).split(',')[0].trim() + '://' + String(host).split(',')[0].trim();
  }

  // -------------------------------------------------------------------------
  // Back office: the printed card
  // -------------------------------------------------------------------------

  router.get('/api/dinein/designs', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Choose an office first.' });
      }
      const [rows] = await pool.query(
        'SELECT * FROM dinein_qr_designs WHERE office_id = ? ORDER BY is_default DESC, id',
        [officeId]
      );
      res.json(rows.map((r) => ({ ...r, elements: parseElements(r.elements) })));
    } catch (e) {
      next(e);
    }
  });

  /**
   * A design's elements, or the starter layout.
   *
   * A brand new design is not empty: an empty page is a page nobody knows what
   * to do with, and every one of these ends up being the same four things — the
   * venue's name, the code, the table's name and a line telling somebody to
   * scan it. So that is what a new one arrives as, ready to be moved.
   */
  function parseElements(raw) {
    if (!raw) return defaultElements();
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : defaultElements();
    } catch {
      return defaultElements();
    }
  }

  function defaultElements() {
    return [
      { kind: 'venue_name', x: 10, y: 6, w: 80, h: 10, size: 26, align: 'center', bold: true },
      { kind: 'qr', x: 22, y: 22, w: 56, h: 40 },
      { kind: 'table_name', x: 10, y: 66, w: 80, h: 9, size: 22, align: 'center', bold: true },
      { kind: 'text', x: 10, y: 78, w: 80, h: 8, size: 13, align: 'center',
        text: 'Scan to see the menu and order' },
    ];
  }

  router.post('/api/dinein/designs', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Choose an office first.' });
      }
      const b = req.body || {};
      const [r] = await pool.execute(
        'INSERT INTO dinein_qr_designs' +
          ' (office_id, name, page_size, page_w_mm, page_h_mm, background, elements, is_default)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          officeId,
          String(b.name || 'Table card').trim().slice(0, 120),
          String(b.page_size || 'a5').slice(0, 24),
          Number(b.page_w_mm) || 148,
          Number(b.page_h_mm) || 210,
          String(b.background || '#FFFFFF').slice(0, 16),
          JSON.stringify(b.elements || defaultElements()),
          b.is_default ? 1 : 0,
        ]
      );
      res.status(201).json({ id: r.insertId });
    } catch (e) {
      next(e);
    }
  });

  router.put('/api/dinein/designs/:id', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      const b = req.body || {};
      const sets = [];
      const params = [];
      for (const field of ['name', 'page_size', 'background']) {
        if (b[field] === undefined) continue;
        sets.push(field + ' = ?');
        params.push(String(b[field]).slice(0, 120));
      }
      for (const field of ['page_w_mm', 'page_h_mm']) {
        if (b[field] === undefined) continue;
        sets.push(field + ' = ?');
        params.push(Number(b[field]) || 0);
      }
      if (b.elements !== undefined) {
        sets.push('elements = ?');
        params.push(JSON.stringify(b.elements));
      }
      if (b.is_default !== undefined) {
        sets.push('is_default = ?');
        params.push(b.is_default ? 1 : 0);
      }
      if (!sets.length) return res.json({ ok: true, changed: 0 });

      const [r] = await pool.execute(
        'UPDATE dinein_qr_designs SET ' + sets.join(', ') + ' WHERE id = ?' +
          (officeId == null ? '' : ' AND office_id = ?'),
        officeId == null
          ? [...params, req.params.id]
          : [...params, req.params.id, officeId]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'Design not found.' });

      // Only one default. Done after the write rather than before, so a failed
      // save cannot leave the venue with no default at all.
      if (b.is_default) {
        await pool.execute(
          'UPDATE dinein_qr_designs SET is_default = 0 WHERE office_id = ? AND id <> ?',
          [officeId, req.params.id]
        );
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/api/dinein/designs/:id', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      const [r] = await pool.execute(
        'DELETE FROM dinein_qr_designs WHERE id = ?' +
          (officeId == null ? '' : ' AND office_id = ?'),
        officeId == null ? [req.params.id] : [req.params.id, officeId]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'Design not found.' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Back office: what has been ordered
  // -------------------------------------------------------------------------

  router.get('/api/dinein/orders', auth, async (req, res, next) => {
    try {
      const officeId = await officeOf(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Choose an office first.' });
      }
      const orders = await readOrders(officeId, {
        status: req.query.status,
        limit: Number(req.query.limit) || 100,
      });
      res.json(orders);
    } catch (e) {
      next(e);
    }
  });

  /**
   * Orders with their lines, in one pair of queries rather than N+1.
   *
   * The till polls the waiting list every few seconds as a backstop to the
   * socket, so this runs far more often than its size suggests.
   */
  async function readOrders(officeId, { status, limit = 100, sinceHours = 24 } = {}) {
    const filters = ['office_id = ?'];
    const params = [officeId];
    if (status) {
      const wanted = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      if (wanted.length) {
        filters.push('status IN (' + wanted.map(() => '?').join(',') + ')');
        params.push(...wanted);
      }
    }
    filters.push('placed_at >= (NOW() - INTERVAL ? HOUR)');
    params.push(sinceHours);

    const capped = Math.max(1, Math.min(500, Number(limit) || 100));
    // The table's current number comes along, because that is what the till
    // places a bill against and it is not what the order stored — the order
    // holds the table's *id* and the label it had at the time, on purpose (see
    // schema_menu_dinein.sql). Joined rather than copied so a table renumbered
    // between the order and the clerk accepting it puts the food on the right
    // bill. LEFT, so an order whose table has since been deleted still reaches
    // the till, which then asks the clerk where to put it.
    const [orders] = await pool.query(
      'SELECT o.*, t.table_number' +
        '  FROM dinein_orders o' +
        '  LEFT JOIN floor_tables t ON t.id = o.table_id' +
        ' WHERE ' + filters.map((f) => 'o.' + f).join(' AND ') +
        ' ORDER BY o.placed_at DESC LIMIT ' + capped,
      params
    );
    if (!orders.length) return [];

    const [lines] = await pool.query(
      'SELECT * FROM dinein_order_lines WHERE dinein_order_id IN (' +
        orders.map(() => '?').join(',') + ') ORDER BY id',
      orders.map((o) => o.id)
    );
    return orders.map((o) => ({
      ...o,
      lines: lines.filter((l) => l.dinein_order_id === o.id),
    }));
  }

  // -------------------------------------------------------------------------
  // The customer's phone
  // -------------------------------------------------------------------------

  /**
   * Open a table by the id printed on its card.
   *
   * Everything the phone needs in one reply: the venue, the table, and the
   * menu. One request rather than three, because this is the first thing that
   * happens after a scan and it is happening on pub wifi.
   */
  router.get('/api/public/dinein/table/:publicId', async (req, res, next) => {
    try {
      const [[table]] = await pool.query(
        'SELECT t.id, t.office_id, t.table_number, t.name, t.label, t.qr_enabled,' +
          '       r.name AS room_name' +
          '  FROM floor_tables t' +
          '  LEFT JOIN floor_rooms r ON r.id = t.room_id' +
          ' WHERE t.public_id = ?',
        [req.params.publicId]
      );
      if (!table) {
        return res.status(404).json({ error: 'That code does not match a table.' });
      }
      const payload = await menuFor(table.office_id, req);
      if (payload.error) return res.status(payload.status || 404).json(payload);

      res.json({
        ...payload,
        table: {
          public_id: req.params.publicId,
          name: tableName(table),
          room: table.room_name || null,
          // A table whose code has been turned off still resolves, and says so.
          // A dead link is indistinguishable from a broken one to the person
          // holding the phone, and they will ask a member of staff either way —
          // better that the screen answers the question first.
          ordering: !!table.qr_enabled,
        },
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * The floor, for somebody who opened the menu without scanning a table.
   *
   * WHY THERE IS A PICKER AT ALL
   *
   * A code on a table answers "where do I take this" without anybody being
   * asked, and that stays the way in. Somebody who followed a link instead —
   * off the venue's website, or from a friend — has no code, and until now
   * simply could not order at all. This is the fallback, and it is deliberately
   * the fallback: scanning is one action, choosing off a plan is three.
   *
   * WHAT IS AND IS NOT SENT
   *
   * The rooms, and the tables that take orders, with their positions — so the
   * plan a customer sees is the plan the venue drew rather than a list of
   * numbers. Each table's printed code comes with it, because choosing a table
   * here has to place an order by exactly the route scanning it would.
   *
   * `busy` says a bill is already open on that table, read from the till's own
   * open bills rather than from anything the menu remembers. It is shown, and
   * it is still selectable: a table with a bill on it is the commonest table to
   * be sitting at, and a second round belongs on that same bill. What the flag
   * is for is the other case — somebody about to pick an empty table they are
   * not actually sitting at gets to see that it is empty.
   *
   * Nothing about the bill itself is sent. What is on it, what it comes to and
   * who is on it are none of a stranger's business, and "busy" is the whole of
   * what a picker needs to know.
   */
  router.get('/api/public/dinein/floor/:slug', async (req, res, next) => {
    try {
      const [[venue]] = await pool.query(
        'SELECT office_id, display_name, is_published FROM dinein_venue WHERE slug = ?',
        [cleanSlug(req.params.slug)]
      );
      if (!venue || !venue.is_published) {
        return res.status(404).json({ error: 'No venue at that address.' });
      }

      const [rooms] = await pool.query(
        'SELECT id, name, sort_order, outline, cols, `rows` FROM floor_rooms' +
          ' WHERE office_id = ? ORDER BY sort_order, id',
        [venue.office_id]
      );
      const [tables] = await pool.query(
        'SELECT id, room_id, table_number, label, name, public_id,' +
          ' pos_x, pos_y, width, height, shape, seats FROM floor_tables' +
          ' WHERE office_id = ? AND qr_enabled = 1 AND public_id IS NOT NULL' +
          ' ORDER BY table_number',
        [venue.office_id]
      );

      // The till tenants its open bills on the office's contact email, the same
      // way the catalogue is tenanted. Without a match here every table would
      // read as free, which is worse than not showing the state at all.
      const email = await emailOf(venue.office_id);
      let busy = new Set();
      if (email) {
        const [open] = await pool.query(
          "SELECT DISTINCT table_number, room_id FROM epos_open_bills" +
            " WHERE office = ? AND status <> 'closed'",
          [email]
        );
        busy = new Set(open.map((o) => String(o.table_number)));
      }

      res.json({
        venue: { name: (venue.display_name || '').trim() || null },
        rooms: rooms.map((r) => ({
          id: r.id,
          name: r.name,
          cols: r.cols || 12,
          rows: r.rows || 8,
          outline: r.outline || null,
        })),
        tables: tables.map((t) => ({
          public_id: t.public_id,
          room_id: t.room_id,
          name: tableName(t),
          seats: t.seats || null,
          x: t.pos_x, y: t.pos_y, w: t.width, h: t.height,
          shape: t.shape || 'rect',
          busy: busy.has(String(t.table_number)),
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  /** The same menu, reached by the venue's own address rather than a table. */
  router.get('/api/public/dinein/venue/:slug', async (req, res, next) => {
    try {
      const [[venue]] = await pool.query(
        'SELECT office_id FROM dinein_venue WHERE slug = ?',
        [cleanSlug(req.params.slug)]
      );
      if (!venue) return res.status(404).json({ error: 'No venue at that address.' });
      const payload = await menuFor(venue.office_id, req);
      if (payload.error) return res.status(payload.status || 404).json(payload);
      // No table, so no ordering: a customer who found the menu on the website
      // is not sitting anywhere, and food has to go somewhere.
      res.json({ ...payload, table: null });
    } catch (e) {
      next(e);
    }
  });

  /**
   * The published menu for one office, priced from the live catalogue.
   *
   * The price is joined at read time and never stored on the menu row. A menu
   * carrying its own prices is a second price list, and the one that goes stale
   * is always the one the customer is reading.
   */
  async function menuFor(officeId, req) {
    const [[venue]] = await pool.query(
      'SELECT * FROM dinein_venue WHERE office_id = ?',
      [officeId]
    );
    if (!venue || !venue.is_published) {
      return {
        error: 'This menu is not open yet.',
        status: 404,
      };
    }

    const [[office]] = await pool.query(
      'SELECT name FROM offices WHERE id = ?',
      [officeId]
    );
    const email = await emailOf(officeId);

    const [sections] = await pool.query(
      'SELECT id, name, blurb, image_url FROM dinein_sections' +
        ' WHERE office_id = ? AND active = 1 ORDER BY sort_order, id',
      [officeId]
    );

    let items = [];
    if (sections.length) {
      const [rows] = await pool.query(
        'SELECT i.id, i.section_id, i.plu_id, i.description, i.image_url,' +
          '       i.available, i.is_popular, i.is_featured, i.diet_tag,' +
          '       COALESCE(NULLIF(TRIM(i.name), ""), p.product_name) AS name,' +
          '       p.price AS price' +
          '  FROM dinein_items i' +
          '  JOIN bo_products p ON p.pluid = i.plu_id AND p.email = ?' +
          ' WHERE i.section_id IN (' + sections.map(() => '?').join(',') + ')' +
          ' ORDER BY i.sort_order, i.id',
        [email, ...sections.map((s) => s.id)]
      );
      items = rows;
    }

    return {
      venue: {
        // Its own address, so a page reached by a table code — which carries no
        // slug in its URL — still knows which venue it is showing, and can be
        // returned to later.
        slug: venue.slug || null,
        name: (venue.display_name || (office ? office.name : '') || '').trim(),
        tagline: venue.tagline,
        phone: venue.phone,
        address: [venue.address_line, venue.postcode].filter(Boolean).join(', '),
        map_url: venue.map_url,
        logo_url: venue.logo_url,
        banner_url: venue.banner_url,
        accent: venue.accent_colour || '#A5C715',
        notice: venue.notice,
        ordering_open: !!venue.ordering_open,
        require_name: !!venue.require_name,
        require_phone: !!venue.require_phone,
        // The venue's own colours, not Vesopa's. Cleaned server-side: these
        // end up in a <style> block on a public page.
        theme: cleanTheme(venue.theme_json),
        offer: offerOf(venue),
        promotions: cleanPromotions(venue.promotions),
        // Two lists, and whether the venue wants either shown. A venue with
        // eight dishes does not want two grids of them above its own menu.
        show_popular: venue.show_popular == null ? true : !!venue.show_popular,
        show_featured: venue.show_featured == null ? true : !!venue.show_featured,
        popular_title: (venue.popular_title || '').trim() || 'Popular',
        featured_title: (venue.featured_title || '').trim() || 'Featured',
        // The hours, and the venue's own answer to "are you open" — worked out
        // here rather than on the phone, whose clock is not evidence.
        schedule: openState(venue),
        closed_message: venue.closed_message || null,
        eta_minutes: Number(venue.eta_minutes) || 25,
        base: publicBase(req, venue),
      },
      sections: sections.map((s) => ({
        ...s,
        items: items
          .filter((i) => i.section_id === s.id)
          .map((i) => ({
            id: i.id,
            plu_id: i.plu_id,
            name: i.name,
            description: i.description,
            image_url: i.image_url,
            available: !!i.available,
            popular: !!i.is_popular,
            featured: !!i.is_featured,
            diet: i.diet_tag || null,
            price_minor: Math.round(Number(i.price || 0) * 100),
          })),
      })),
    };
  }

  /**
   * Place an order.
   *
   * PRICED HERE, NOT ON THE PHONE
   *
   * The basket that arrives carries menu item ids and quantities, and nothing
   * else is believed. Every price and every name is read back out of the
   * catalogue inside the transaction that writes the order, so a customer who
   * edits the page in front of them changes what they see and not what they are
   * charged — and so a price the venue changed while somebody was reading is
   * the price that applies.
   */
  router.post('/api/public/dinein/table/:publicId/order', async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const [[table]] = await conn.query(
        'SELECT t.id, t.office_id, t.table_number, t.name, t.label, t.qr_enabled' +
          '  FROM floor_tables t WHERE t.public_id = ?',
        [req.params.publicId]
      );
      if (!table) {
        return res.status(404).json({ error: 'That code does not match a table.' });
      }
      if (!table.qr_enabled) {
        return res.status(403).json({
          error: 'This table is not taking orders from phones. Please order at the bar.',
        });
      }

      const [[venue]] = await conn.query(
        'SELECT * FROM dinein_venue WHERE office_id = ?',
        [table.office_id]
      );
      if (!venue || !venue.is_published || !venue.ordering_open) {
        return res.status(403).json({
          error: 'The kitchen is not taking orders through the app just now.',
        });
      }

      // Outside the venue's own hours nothing is taken. The page knows this and
      // says so before anybody fills a basket, but the page is not the
      // authority: a tab left open since lunchtime, a cached copy, or anybody
      // calling this endpoint directly all arrive here, and the kitchen closing
      // has to mean the same thing to all of them.
      const state = openState(venue);
      if (state.enforced && !state.open) {
        return res.status(409).json({
          error: venue.closed_message
            || (state.next
              ? 'The kitchen is closed. It opens ' +
                (state.next.today ? 'today' : state.next.day) + ' at ' + state.next.at + '.'
              : 'The kitchen is closed just now.'),
          closed: true,
          schedule: state,
        });
      }

      const offer = offerOf(venue);

      // Signed in or not. A guest order is the ordinary case and carries null.
      const who = dinerOf(req);
      const dinerId = who && who.office === table.office_id ? who.id : null;

      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 120);
      const phone = String(body.phone || '').trim().slice(0, 40);
      if (venue.require_name && !name) {
        return res.status(400).json({ error: 'Please leave a name.' });
      }
      if (venue.require_phone && !phone) {
        return res.status(400).json({ error: 'Please leave a phone number.' });
      }

      const basket = Array.isArray(body.lines) ? body.lines : [];
      const wanted = new Map();
      for (const line of basket) {
        const id = Number(line && line.item_id);
        const qty = Math.max(1, Math.min(99, Number(line && line.qty) || 1));
        if (!Number.isInteger(id) || id <= 0) continue;
        const note = String((line && line.note) || '').trim().slice(0, 300);
        // Same item twice with different notes is two lines, not one of four.
        wanted.set(id + '|' + note, { id, qty, note });
      }
      if (!wanted.size) {
        return res.status(400).json({ error: 'There is nothing in the basket.' });
      }

      const ids = [...new Set([...wanted.values()].map((w) => w.id))];
      const email = await emailOf(table.office_id);
      const [rows] = await conn.query(
        'SELECT i.id, i.plu_id, i.available,' +
          '       COALESCE(NULLIF(TRIM(i.name), ""), p.product_name) AS name,' +
          '       p.price AS price' +
          '  FROM dinein_items i' +
          '  JOIN bo_products p ON p.pluid = i.plu_id AND p.email = ?' +
          ' WHERE i.office_id = ? AND i.id IN (' + ids.map(() => '?').join(',') + ')',
        [email, table.office_id, ...ids]
      );
      const priced = new Map(rows.map((r) => [r.id, r]));

      const lines = [];
      let total = 0;
      for (const want of wanted.values()) {
        const item = priced.get(want.id);
        // Silently dropping an unavailable item would send somebody food they
        // did not order and leave off the thing they did.
        if (!item) {
          return res.status(409).json({
            error: 'Something on the menu changed while you were ordering. Please check your basket.',
          });
        }
        if (!item.available) {
          return res.status(409).json({
            error: 'Sorry, ' + item.name + ' has just sold out.',
          });
        }
        const unit = Math.round(Number(item.price || 0) * 100);
        total += unit * want.qty;
        lines.push({
          plu_id: item.plu_id,
          name: item.name,
          qty: want.qty,
          unit,
          note: want.note || null,
        });
      }

      // The offer, applied here and nowhere else.
      //
      // The page quotes a discount and this stores one, and those two
      // disagreeing is somebody being charged a figure they were never shown.
      // So the page's arithmetic is treated as a display of this, never as an
      // input to it: nothing about the discount is read from the request.
      const subtotal = total;
      const discount = discountFor(offer, subtotal);
      total = subtotal - discount;

      const publicId = newPublicId();
      const label = tableName(table);

      await conn.beginTransaction();
      const [order] = await conn.execute(
        'INSERT INTO dinein_orders' +
          ' (public_id, office_id, table_id, table_label, customer_name,' +
          '  customer_phone, note, status, diner_id, total_minor)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          publicId,
          table.office_id,
          table.id,
          label,
          name || null,
          phone || null,
          String(body.note || '').trim().slice(0, 500) || null,
          'placed',
          dinerId,
          total,
        ]
      );
      for (const line of lines) {
        await conn.execute(
          'INSERT INTO dinein_order_lines' +
            ' (dinein_order_id, plu_id, name, qty, unit_price_minor, note)' +
            ' VALUES (?, ?, ?, ?, ?, ?)',
          [order.insertId, line.plu_id, line.name, line.qty, line.unit, line.note]
        );
      }
      await conn.commit();

      // The till is told immediately. Scoped to the office, so one venue's
      // socket never sees another's order arrive.
      broadcast(
        {
          type: 'dinein.order',
          order_id: order.insertId,
          public_id: publicId,
          table: label,
          total_minor: total,
          lines: lines.length,
        },
        { office: email }
      );

      res.status(201).json({
        ok: true,
        public_id: publicId,
        // The number the tracker shows and the customer says across a bar.
        number: order.insertId,
        subtotal_minor: subtotal,
        discount_minor: discount,
        total_minor: total,
        status: 'placed',
      });
    } catch (e) {
      await conn.rollback().catch(() => {});
      next(e);
    } finally {
      conn.release();
    }
  });

  /** Where an order has got to, for the customer watching their own phone. */
  // =========================================================================
  // OPTIONAL ACCOUNTS
  // =========================================================================
  //
  // Ordering as a guest is the default and stays the default. Somebody sitting
  // at a table with a plate coming is not going to make an account first, and
  // asking them to is how a QR menu gets abandoned halfway through a basket.
  //
  // An account buys exactly one thing: the orders you have placed, on whatever
  // phone you are holding. Everything else works identically without one.
  //
  // Scoped per venue, like every other table in this system. A single
  // platform-wide identity would put one venue's customer list within reach of
  // a bug in another venue's code path, and the venues are separate businesses.

  const DINER_DAYS = 90;

  /** The office behind a slug, or null. */
  async function officeForSlug(slug) {
    const [[row]] = await pool.query(
      'SELECT office_id FROM dinein_venue WHERE slug = ? AND is_published = 1',
      [cleanSlug(slug)]
    );
    return row ? row.office_id : null;
  }

  /** The office behind a table's printed code, or null. */
  async function officeForTable(publicId) {
    const [[row]] = await pool.query(
      'SELECT office_id FROM floor_tables WHERE public_id = ?',
      [String(publicId || '')]
    );
    return row ? row.office_id : null;
  }

  function dinerToken(diner) {
    return jwt.sign(
      { scope: 'diner', diner: diner.id, office: diner.office_id },
      secret,
      { expiresIn: DINER_DAYS + 'd' }
    );
  }

  /**
   * Who is asking, if anybody.
   *
   * Never throws and never refuses: an expired or malformed token means a
   * guest, not an error. A customer whose token has aged out mid-meal should
   * be able to keep ordering, not be shown a login wall between them and their
   * chips.
   */
  function dinerOf(req) {
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

  const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

  router.post('/api/public/dinein/account/register', async (req, res, next) => {
    try {
      const body = req.body || {};
      const officeId = body.table
        ? await officeForTable(body.table)
        : await officeForSlug(body.slug);
      if (officeId == null) {
        return res.status(404).json({ error: 'No venue at that address.' });
      }

      const email = String(body.email || '').trim().toLowerCase().slice(0, 190);
      const password = String(body.password || '');
      if (!EMAIL.test(email)) {
        return res.status(400).json({ error: 'That does not look like an email address.' });
      }
      // Length, and nothing else. Composition rules push people towards
      // Passw0rd! and away from three words they will remember.
      if (password.length < 8) {
        return res.status(400).json({ error: 'Use at least eight characters.' });
      }

      const [[existing]] = await pool.query(
        'SELECT id FROM dinein_diners WHERE office_id = ? AND email = ?',
        [officeId, email]
      );
      if (existing) {
        return res.status(409).json({
          error: 'There is already an account with that address here. Sign in instead.',
        });
      }

      const hash = await bcrypt.hash(password, 10);
      const [r] = await pool.execute(
        'INSERT INTO dinein_diners (office_id, email, pass_hash, name, phone, last_seen)' +
          ' VALUES (?, ?, ?, ?, ?, NOW())',
        [
          officeId, email, hash,
          String(body.name || '').trim().slice(0, 120) || null,
          String(body.phone || '').trim().slice(0, 40) || null,
        ]
      );
      const diner = { id: r.insertId, office_id: officeId };
      res.json({
        ok: true,
        token: dinerToken(diner),
        account: { email, name: body.name || null, phone: body.phone || null },
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/api/public/dinein/account/login', async (req, res, next) => {
    try {
      const body = req.body || {};
      const officeId = body.table
        ? await officeForTable(body.table)
        : await officeForSlug(body.slug);
      if (officeId == null) {
        return res.status(404).json({ error: 'No venue at that address.' });
      }

      const email = String(body.email || '').trim().toLowerCase();
      const [[diner]] = await pool.query(
        'SELECT * FROM dinein_diners WHERE office_id = ? AND email = ?',
        [officeId, email]
      );

      // The same answer either way. Telling somebody an address is not
      // registered here tells anybody who asks which of a venue's customers
      // have accounts.
      const wrong = { error: 'That email and password do not match.' };
      if (!diner) {
        // Still spend the time, so that a missing account is not detectably
        // faster than a wrong password.
        await bcrypt.compare(String(body.password || ''), '$2a$10$' + 'x'.repeat(53));
        return res.status(401).json(wrong);
      }
      const ok = await bcrypt.compare(String(body.password || ''), diner.pass_hash);
      if (!ok) return res.status(401).json(wrong);

      await pool.execute('UPDATE dinein_diners SET last_seen = NOW() WHERE id = ?', [diner.id]);
      res.json({
        ok: true,
        token: dinerToken(diner),
        account: { email: diner.email, name: diner.name, phone: diner.phone },
      });
    } catch (e) {
      next(e);
    }
  });

  /** Everything this account has ordered here, newest first. */
  router.get('/api/public/dinein/account/orders', async (req, res, next) => {
    try {
      const who = dinerOf(req);
      if (!who) return res.status(401).json({ error: 'Sign in to see your orders.' });
      const [rows] = await pool.query(
        'SELECT id AS number, public_id, table_label, status, total_minor, placed_at' +
          '  FROM dinein_orders' +
          ' WHERE diner_id = ? AND office_id = ?' +
          ' ORDER BY placed_at DESC LIMIT 50',
        [who.id, who.office]
      );
      res.json({ orders: rows });
    } catch (e) {
      next(e);
    }
  });

  router.get('/api/public/dinein/order/:publicId', async (req, res, next) => {
    try {
      // The venue comes with it.
      //
      // Somebody who has just ordered is on a page with no way back to the menu
      // they ordered from — and the address they arrived at, /o/<32 characters>,
      // says nothing about where they are. Joining the venue here is what lets
      // that page offer a way back, and name the place while it is at it.
      const [[order]] = await pool.query(
        'SELECT o.id, o.public_id, o.table_label, o.status, o.status_note,' +
          '       o.total_minor, o.eta_minutes, o.placed_at, o.accepted_at,' +
          '       o.ready_at, o.served_at,' +
          '       v.slug AS venue_slug, v.display_name AS venue_name' +
          '  FROM dinein_orders o' +
          '  LEFT JOIN dinein_venue v ON v.office_id = o.office_id' +
          ' WHERE o.public_id = ?',
        [req.params.publicId]
      );
      if (!order) return res.status(404).json({ error: 'No such order.' });
      const [lines] = await pool.query(
        'SELECT name, qty, unit_price_minor, note FROM dinein_order_lines' +
          ' WHERE dinein_order_id = (SELECT id FROM dinein_orders WHERE public_id = ?)' +
          ' ORDER BY id',
        [req.params.publicId]
      );
      // A number somebody can say across a bar. The public_id is 32 random
      // characters because it has to be unguessable; that is the opposite of
      // what you want when a customer is trying to tell a member of staff which
      // order is theirs. The row id is already unique and already sequential.
      const { id, venue_slug: slug, venue_name: name, ...rest } = order;
      res.json({
        ...rest,
        number: id,
        lines,
        // Null on a venue that has since been unpublished or renamed away. The
        // page checks before it offers a link, rather than sending somebody to
        // an address that answers 404.
        venue: slug ? { slug, name: (name || '').trim() || null } : null,
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Withdraw an order that nobody has picked up yet.
   *
   * Only from `placed`. Once a clerk has accepted it the kitchen may already
   * have it, and a customer cancelling food that is under a grill is a decision
   * for the person standing next to the grill.
   */
  router.post('/api/public/dinein/order/:publicId/cancel', async (req, res, next) => {
    try {
      const [r] = await pool.execute(
        'UPDATE dinein_orders SET status = ?, status_note = ?' +
          ' WHERE public_id = ? AND status = ?',
        ['cancelled', 'Cancelled by the customer', req.params.publicId, 'placed']
      );
      if (!r.affectedRows) {
        return res.status(409).json({
          error: 'That order has already been picked up. Please speak to a member of staff.',
        });
      }
      const [[order]] = await pool.query(
        'SELECT office_id FROM dinein_orders WHERE public_id = ?',
        [req.params.publicId]
      );
      if (order) {
        broadcast(
          { type: 'dinein.changed', public_id: req.params.publicId },
          { office: await emailOf(order.office_id) }
        );
      }
      res.json({ ok: true, status: 'cancelled' });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // The till
  // -------------------------------------------------------------------------

  /**
   * Which office a commissioned terminal belongs to.
   *
   * `officeId` has been on the terminal token since it was introduced, but the
   * email is what a till commissioned on an older build is certain to carry —
   * so the id is preferred and the email is the fallback, rather than a till
   * that has not been signed in again since being told it has no orders.
   */
  async function terminalOffice(req) {
    if (req.terminal && req.terminal.officeId) return req.terminal.officeId;
    if (!req.office) return null;
    const [[office]] = await pool.query(
      'SELECT id FROM offices WHERE contact_email = ?',
      [req.office]
    );
    return office ? office.id : null;
  }

  /**
   * What is waiting, for the till's notification.
   *
   * The `status` filter defaults to the three states a clerk can act on,
   * because the commonest call by far is "is there anything for me".
   */
  router.get('/till/dinein/orders', terminal, async (req, res, next) => {
    try {
      const officeId = await terminalOffice(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Unknown office.' });
      }
      res.json(
        await readOrders(officeId, {
          status: req.query.status || 'placed,accepted,ready',
          limit: Number(req.query.limit) || 50,
        })
      );
    } catch (e) {
      next(e);
    }
  });

  /**
   * Move an order along.
   *
   * The transitions are stated rather than implied, so a stale screen cannot
   * move an order backwards. A clerk pressing Accept on a notification that has
   * already been accepted by the terminal next to them gets a plain refusal
   * instead of a second kitchen ticket.
   */
  const ALLOWED = {
    accepted: ['placed'],
    ready: ['accepted'],
    served: ['accepted', 'ready'],
    rejected: ['placed', 'accepted'],
  };

  router.post('/till/dinein/orders/:id/:action', terminal, async (req, res, next) => {
    try {
      const officeId = await terminalOffice(req);
      if (officeId == null) {
        return res.status(400).json({ error: 'Unknown office.' });
      }
      const action = String(req.params.action);
      const from = ALLOWED[action];
      if (!from) return res.status(400).json({ error: 'Unknown action.' });

      const stamp = {
        accepted: 'accepted_at',
        ready: 'ready_at',
        served: 'served_at',
      }[action];

      // Accepting is the moment a customer is promised a time, so the venue's
      // current setting is copied onto the order rather than read back from the
      // venue when the tracker draws. Otherwise a landlord changing the default
      // from twenty minutes to forty at eight o'clock would silently move the
      // clock on everybody already waiting.
      let eta = null;
      if (action === 'accepted') {
        const [[venue]] = await pool.query(
          'SELECT eta_minutes FROM dinein_venue WHERE office_id = ?',
          [officeId]
        );
        eta = venue && venue.eta_minutes != null ? Number(venue.eta_minutes) : 25;
      }

      const [r] = await pool.execute(
        'UPDATE dinein_orders SET status = ?, status_note = ?' +
          (stamp ? ', ' + stamp + ' = NOW()' : '') +
          (eta != null ? ', eta_minutes = ?' : '') +
          (req.body && req.body.order_id ? ', order_id = ?' : '') +
          ' WHERE id = ? AND office_id = ? AND status IN (' +
          from.map(() => '?').join(',') + ')',
        [
          action,
          (req.body && req.body.note ? String(req.body.note).slice(0, 300) : null),
          ...(eta != null ? [eta] : []),
          ...(req.body && req.body.order_id ? [String(req.body.order_id)] : []),
          req.params.id,
          officeId,
          ...from,
        ]
      );
      if (!r.affectedRows) {
        return res.status(409).json({
          error: 'That order has already moved on. Refresh to see where it is.',
        });
      }
      broadcast(
        { type: 'dinein.changed', order_id: Number(req.params.id), status: action },
        { office: await emailOf(officeId) }
      );
      res.json({ ok: true, status: action });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// `openState` and `parseHours` are exported for the test that drives them
// directly. They are pure functions of a venue row and the clock, and the
// alternative — asserting on them through an HTTP route — would mean standing
// up a venue for every one of a dozen cases about midnight.
module.exports = {
  dineinRoutes,
  openState, parseHours, cleanTime,
  // cleanTheme is interpolated into a <style> block on a public page and
  // discountFor decides what somebody pays. Both are pure and both are driven
  // directly by dinein-offers.test.js.
  cleanTheme, cleanPromotions, offerOf, discountFor,
};
