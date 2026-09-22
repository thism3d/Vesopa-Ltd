/**
 * Cash denominations — the note keys the till shows when taking cash.
 *
 * Resolution rule, in one place so the back office and the till can never
 * disagree: an office's own rows win; if it has none, the platform defaults
 * (office_id IS NULL) are served. That means a venue gets working £50/£20/£10/£5
 * keys the day it is created, and only starts carrying its own rows the moment
 * somebody edits them.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { requireAuth } = require('./auth');

// Same disk-backed, size-capped, type-checked upload as product images. A note
// picture is the same kind of thing and there is no reason for a second policy.
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'public', 'uploads'),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    cb(ok.includes(file.mimetype) ? null : new Error('Images only'), ok.includes(file.mimetype));
  },
});

/** The rows an office should see: its own if it has any, otherwise defaults. */
async function denominationsFor(pool, officeId) {
  if (officeId) {
    const [own] = await pool.query(
      `SELECT id, value_minor, label, image_url, sort_order, active
         FROM cash_denominations
        WHERE office_id = ?
        ORDER BY sort_order, value_minor DESC`,
      [officeId]
    );
    if (own.length > 0) return { rows: own, inherited: false };
  }

  const [defaults] = await pool.query(
    `SELECT id, value_minor, label, image_url, sort_order, active
       FROM cash_denominations
      WHERE office_id IS NULL
      ORDER BY sort_order, value_minor DESC`
  );
  return { rows: defaults, inherited: true };
}

/** Reject anything that would produce a key the till cannot render or use. */
function validate(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return 'Send at least one denomination.';
  }
  if (items.length > 24) {
    return 'That is more keys than a till can usefully show.';
  }

  const seen = new Set();
  for (const item of items) {
    const value = Number(item?.value_minor);
    if (!Number.isInteger(value) || value <= 0 || value > 100000) {
      return 'Every denomination needs a whole value between 1p and £1000.';
    }
    if (seen.has(value)) return 'Two denominations share the same value.';
    seen.add(value);

    if (!String(item?.label || '').trim()) {
      return 'Every denomination needs a label.';
    }
    if (String(item?.label).length > 32) {
      return 'Labels are limited to 32 characters.';
    }
    // Only same-origin paths. An off-site URL would be a mixed-content or
    // tracking problem on a till that is often on a locked-down network.
    const url = item?.image_url;
    if (url && !/^\/(uploads|assets)\//.test(String(url))) {
      return 'Images must be uploaded here, not linked from another site.';
    }
  }
  return null;
}

function denominationRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  /** The signed-in user's office, or the one an admin is inspecting. */
  function officeIdFor(req) {
    if (req.user.role === 'admin' && req.query.office_id) {
      return Number(req.query.office_id) || null;
    }
    return req.user.officeId || null;
  }

  router.get('/denominations', auth, async (req, res, next) => {
    try {
      const { rows, inherited } = await denominationsFor(pool, officeIdFor(req));
      // `inherited` lets the back office say "these are the Vesopa defaults"
      // rather than implying the office has already customised them.
      res.json({ denominations: rows, inherited });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Replace this office's set.
   *
   * A whole-set replace rather than per-row PATCHes: the order and the
   * membership of the set are the thing being edited, and a half-applied
   * reorder would leave the till showing keys in an order nobody chose.
   */
  router.put('/denominations', auth, async (req, res, next) => {
    const officeId = officeIdFor(req);
    if (!officeId) {
      return res.status(400).json({
        error: 'Pick an office before editing its denominations.',
      });
    }

    const items = req.body?.denominations;
    const problem = validate(items);
    if (problem) return res.status(400).json({ error: problem });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('DELETE FROM cash_denominations WHERE office_id = ?', [
        officeId,
      ]);

      for (const [i, item] of items.entries()) {
        await conn.execute(
          `INSERT INTO cash_denominations
             (office_id, value_minor, label, image_url, sort_order, active)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            officeId,
            Number(item.value_minor),
            String(item.label).trim(),
            item.image_url ? String(item.image_url) : null,
            i + 1,
            item.active === false ? 0 : 1,
          ]
        );
      }
      await conn.commit();

      const { rows } = await denominationsFor(pool, officeId);
      // Tells every till on the floor to re-pull, so a note picture changed
      // here appears on the counter without anyone restarting the app.
      broadcast?.({ type: 'denominations.changed', officeId });
      res.json({ denominations: rows, inherited: false });
    } catch (e) {
      await conn.rollback().catch(() => {});
      next(e);
    } finally {
      conn.release();
    }
  });

  /**
   * Drop this office's overrides and go back to the Vesopa defaults.
   *
   * Deleting the rows *is* the reset — with none of its own, the office falls
   * through to the defaults again.
   */
  router.delete('/denominations', auth, async (req, res, next) => {
    const officeId = officeIdFor(req);
    if (!officeId) return res.status(400).json({ error: 'No office' });

    try {
      await pool.execute('DELETE FROM cash_denominations WHERE office_id = ?', [
        officeId,
      ]);
      const { rows } = await denominationsFor(pool, officeId);
      broadcast?.({ type: 'denominations.changed', officeId });
      res.json({ denominations: rows, inherited: true });
    } catch (e) {
      next(e);
    }
  });

  /** Upload a note picture; returns the URL to store on the row. */
  router.post('/denomination-image', auth, (req, res) => {
    upload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file' });
      res.status(201).json({ url: `/uploads/${req.file.filename}` });
    });
  });

  return router;
}

/**
 * The till's pull. Unauthenticated and keyed by contact email, exactly like
 * /till/products — a terminal needs its note keys to take cash, and which notes
 * a country uses is not a secret.
 */
function tillDenominationRoutes({ pool }) {
  const router = express.Router();

  router.get('/till/denominations', async (req, res, next) => {
    const email = req.query.office;
    if (!email) {
      return res.status(400).json({
        error: 'An office is required: /till/denominations?office=<contact email>',
      });
    }

    try {
      const [[office]] = await pool.query(
        'SELECT id FROM offices WHERE contact_email = ?',
        [email]
      );
      const { rows } = await denominationsFor(pool, office?.id ?? null);
      res.json(rows.filter((r) => r.active));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { denominationRoutes, tillDenominationRoutes, denominationsFor };
