/**
 * Fonts — the lettering a venue's tills wear.
 *
 * Two kinds, one list. Sixteen built-in families are files in the tree, fetched
 * once by tool/fetch_fonts.js and served from public/assets/fonts; a venue's
 * own uploads are rows in epos_fonts with files under public/uploads/fonts.
 * Everything downstream — the screen editor's picker, the till's cache, a
 * button's `fontFamily` — sees one flat list of families keyed by slug and does
 * not care which kind a font is, except that a built-in cannot be deleted.
 *
 * WHY THE FILES LIVE HERE AND NOT ON A CDN.
 *
 * The obvious build is a <link> to fonts.googleapis.com in the back office and
 * a Google Fonts URL on the till. It is wrong for the till twice over. A till
 * is offline-first by design — it takes money through a broadband outage, which
 * is most of the reason it exists — and a button whose lettering arrives over
 * the internet is a button that changes shape when the line drops. And Flutter's
 * FontLoader reads ttf and otf; Google serves woff2 to anything modern, so the
 * till would have to lie about its user agent to get a file it could use.
 *
 * So the till downloads fonts from this back office, over the same connection
 * it already fetches products and screens on, and caches them on disk. First
 * run needs the network. Nothing after it does.
 *
 * WHY .woff2 IS REFUSED ON UPLOAD.
 *
 * For the same reason, and it is worth refusing loudly rather than storing a
 * file that works in the editor's preview and silently does nothing on the
 * terminal. A manager who uploads their brand woff2, sees it in the back
 * office, and finds plain lettering at the counter has been told a lie by this
 * software. The error names the formats that work.
 *
 * ROUTING, and the trap it avoids.
 *
 *   fontsRoutes      the back office, on a session token.
 *   tillFontRoutes   the tills. The read is unauthenticated and scoped by an
 *                    `office` query, exactly as /till/screens is. The *write*
 *                    is not: uploading a font puts a file on our disk, so it
 *                    takes a terminal token, which is the strongest thing a
 *                    till has to present.
 *
 * As with the kitchen's and the screens' routers, these two must never share a
 * path — the back office's `auth` in front of a till read would take the
 * lettering off every terminal in every venue at once. They do not: the till's
 * live under /till/.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const express = require('express');
const multer = require('multer');

const { requireAuth, requireTerminal } = require('./auth');

const BUILT_IN_DIR = path.join(__dirname, '..', 'public', 'assets', 'fonts');
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'fonts');

/** Weights a family may have. Regular and bold; see tool/fetch_fonts.js. */
const WEIGHTS = [400, 700];

/**
 * A font file is at most this. Four megabytes is a generous CJK face and about
 * twenty times a Latin one — and it is also what a till has to pull down over a
 * venue's broadband before it can draw a button, which is the real ceiling.
 */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * The built-in families, read once at startup from the manifest the fetch tool
 * wrote. Read once rather than per request because these files cannot change
 * without a deploy, and a deploy restarts this process.
 *
 * A missing or unreadable manifest is not fatal. It means no built-in fonts —
 * the venue keeps its uploads, every till falls back to the app's own typeface,
 * and nothing 500s. A back office that will not start because a font list is
 * malformed is a worse outcome than one that letters things plainly.
 */
const BUILT_INS = (() => {
  try {
    const raw = fs.readFileSync(path.join(BUILT_IN_DIR, 'catalogue.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f) => f && f.slug && f.family && Array.isArray(f.faces))
      .map((f) => ({
        slug: String(f.slug),
        family: String(f.family),
        builtIn: true,
        faces: f.faces
          .filter((face) => WEIGHTS.includes(Number(face.weight)))
          .map((face) => ({
            weight: Number(face.weight),
            url: `/assets/fonts/${f.slug}/${face.file}`,
            bytes: Number(face.bytes) || 0,
          }))
          .sort((a, b) => a.weight - b.weight),
      }))
      .filter((f) => f.faces.length);
  } catch {
    return [];
  }
})();

const BUILT_IN_SLUGS = new Set(BUILT_INS.map((f) => f.slug));

/**
 * A family name reduced to the key a button stores.
 *
 * Buttons and till settings hold the slug, never the display name, so a venue
 * can rename "Brand Sans" to "Aishi Display" without every key it letters
 * falling back to plain. That is also why the slug is derived once, on the
 * first upload of a family, and never recomputed from a changed name.
 */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Is this actually a font, by its first four bytes?
 *
 * The extension is what the browser sends and is worth nothing: a .ttf is
 * whatever somebody renamed. These four signatures are the whole of what
 * FontLoader can read.
 *
 *   0x00010000  TrueType outlines — the common .ttf
 *   'true'      TrueType, the older Apple tag
 *   'ttcf'      a TrueType collection
 *   'OTTO'      OpenType with CFF outlines — .otf
 *
 * Deliberately NOT here: 'wOFF' and 'wOF2'. They are real fonts and the browser
 * would render them; the till could not. See the header.
 */
function fontKind(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const tag = buffer.subarray(0, 4).toString('latin1');
  if (tag === 'OTTO') return 'otf';
  if (tag === 'true' || tag === 'ttcf') return 'ttf';
  if (buffer.readUInt32BE(0) === 0x00010000) return 'ttf';
  if (tag === 'wOFF' || tag === 'wOF2') return 'woff';
  return null;
}

/**
 * Uploads land in memory, not on disk.
 *
 * multer's disk storage would write the file before anything had looked at it,
 * so a rejected upload leaves rubbish in public/uploads for somebody to find
 * later — and public/uploads is served statically, which makes "we stored a
 * file we refused" worse than untidy. Four megabytes through RAM is nothing.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

/** The rows a venue uploaded, as families. */
async function uploadedFor(pool, office) {
  const [rows] = await pool.query(
    `SELECT slug, family, weight, file_name, byte_size
       FROM epos_fonts
      WHERE office = ?
      ORDER BY family, weight`,
    [office]
  );

  const bySlug = new Map();
  for (const row of rows) {
    if (!bySlug.has(row.slug)) {
      bySlug.set(row.slug, {
        slug: row.slug,
        family: row.family,
        builtIn: false,
        faces: [],
      });
    }
    bySlug.get(row.slug).faces.push({
      weight: Number(row.weight),
      url: `/uploads/fonts/${row.file_name}`,
      bytes: Number(row.byte_size) || 0,
    });
  }
  return [...bySlug.values()];
}

/**
 * Every font this venue can letter a till in.
 *
 * Built-ins first and in the order the fetch tool listed them — which is
 * roughly "what a till looks best in" rather than alphabetical, because the
 * first few entries are the ones a manager in a hurry picks from. The venue's
 * own follow, sorted by name, because by then they are looking for one.
 */
async function catalogueFor(pool, office) {
  const own = await uploadedFor(pool, office);
  own.sort((a, b) => a.family.localeCompare(b.family));
  // A venue that uploads a family named like a built-in gets its own: it is on
  // their tills because they put it there, and shadowing is a less surprising
  // outcome than an upload that appears to do nothing.
  const shadowed = new Set(own.map((f) => f.slug));
  return [...BUILT_INS.filter((f) => !shadowed.has(f.slug)), ...own];
}

/**
 * Store one uploaded face, replacing whatever that weight was before.
 *
 * Shared by the back office's route and the till's, because "a till uploaded
 * it" and "a manager uploaded it" differ only in who is named in uploaded_by.
 * Two copies of this would be two chances to forget the signature check.
 */
async function storeFace(pool, { office, file, family, weight, by }) {
  const kind = fontKind(file.buffer);
  if (kind === 'woff') {
    const err = new Error(
      'A .woff or .woff2 font works in a browser but not on a till. ' +
        'Upload the .ttf or .otf the foundry supplies alongside it.'
    );
    err.status = 400;
    throw err;
  }
  if (!kind) {
    const err = new Error('That file is not a TrueType or OpenType font.');
    err.status = 400;
    throw err;
  }

  const name = String(family || '').trim().slice(0, 64);
  const slug = slugify(name);
  if (!name || !slug) {
    const err = new Error('Give the font a name.');
    err.status = 400;
    throw err;
  }
  if (BUILT_IN_SLUGS.has(slug)) {
    const err = new Error(
      `“${name}” is one of the built-in fonts. Give yours a different name so ` +
        'the two can be told apart on the till.'
    );
    err.status = 409;
    throw err;
  }

  const w = WEIGHTS.includes(Number(weight)) ? Number(weight) : 400;

  // Named for what it is rather than for what the browser called it, so a
  // directory listing reads `brand-sans-700-....ttf` and not `blob`. The random
  // tail is not decoration: every office writes into one directory, two venues
  // may both have a "Brand Sans", and `brand-sans-700.ttf` would mean whichever
  // uploaded second silently replaced the other venue's font. It also makes the
  // URL of a replaced face different from the one it replaced, which is what
  // stops a browser and a till serving yesterday's file out of cache.
  const tail = crypto.randomBytes(6).toString('hex');
  const fileName = `${slug}-${w}-${tail}.${kind}`;

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), file.buffer);

  // The old file, if this weight is being replaced. Read before the write so a
  // failed write leaves the venue with the font it had.
  const [[previous]] = await pool.query(
    'SELECT file_name FROM epos_fonts WHERE office = ? AND slug = ? AND weight = ?',
    [office, slug, w]
  );

  await pool.query(
    `INSERT INTO epos_fonts (office, family, slug, weight, file_name, byte_size, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       family = VALUES(family),
       file_name = VALUES(file_name),
       byte_size = VALUES(byte_size),
       uploaded_by = VALUES(uploaded_by)`,
    [office, name, slug, w, fileName, file.buffer.length, by || null]
  );

  if (previous && previous.file_name && previous.file_name !== fileName) {
    // Best effort. An orphaned font file is a few hundred kilobytes; a failed
    // upload because the old file was already gone is a manager stuck.
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, previous.file_name));
    } catch {
      /* already gone */
    }
  }

  return { slug, family: name, weight: w, bytes: file.buffer.length };
}

/** Remove a venue's font, file and all. Built-ins refuse. */
async function removeFamily(pool, office, slug) {
  if (BUILT_IN_SLUGS.has(slug)) {
    const err = new Error('The built-in fonts cannot be removed.');
    err.status = 400;
    throw err;
  }

  const [rows] = await pool.query(
    'SELECT file_name FROM epos_fonts WHERE office = ? AND slug = ?',
    [office, slug]
  );
  if (!rows.length) return false;

  await pool.query('DELETE FROM epos_fonts WHERE office = ? AND slug = ?', [
    office,
    slug,
  ]);
  for (const row of rows) {
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, row.file_name));
    } catch {
      /* already gone */
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The back office
// ---------------------------------------------------------------------------

function fontsRoutes({ pool, secret, broadcast }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query(
        'SELECT contact_email FROM offices WHERE id = ?',
        [req.user.officeId]
      );
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  /**
   * Tell this venue's tills the font list moved.
   *
   * Reusing the `screens` push rather than minting a `fonts` one: a till that
   * hears "screens" already re-reads its layout, and the fonts a layout needs
   * are fetched in the same breath. A second message would mean a second
   * handler on the till and a version of the till that ignores it.
   */
  function pushed(office) {
    broadcast({ type: 'screens', office }, { office });
  }

  router.get('/fonts', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      res.json({ fonts: await catalogueFor(pool, office) });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Upload one face of one family.
   *
   * `family` and `weight` are fields beside the file rather than parsed out of
   * the filename. A foundry's file is called `BrandSans-Bd_v2_FINAL.ttf` and
   * guessing "Bd" means 700 is the kind of cleverness that letters half a
   * venue's buttons in the wrong weight.
   */
  router.post('/fonts', auth, (req, res, next) => {
    upload.single('font')(req, res, async (err) => {
      if (err) {
        return res.status(400).json({
          error:
            err.code === 'LIMIT_FILE_SIZE'
              ? `That font is larger than ${MAX_BYTES / 1024 / 1024} MB.`
              : 'That upload could not be read.',
        });
      }
      if (!req.file) return res.status(400).json({ error: 'No font was sent.' });

      try {
        const office = await tenantEmail(req);
        const stored = await storeFace(pool, {
          office,
          file: req.file,
          family: req.body.family,
          weight: req.body.weight,
          by: req.user.email,
        });
        pushed(office);
        res.status(201).json(stored);
      } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        next(e);
      }
    });
  });

  router.delete('/fonts/:slug', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const gone = await removeFamily(pool, office, String(req.params.slug));
      if (!gone) return res.status(404).json({ error: 'No such font.' });
      pushed(office);
      res.json({ ok: true });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// The tills
// ---------------------------------------------------------------------------

function tillFontRoutes({ pool, secret, broadcast }) {
  const router = express.Router();

  /**
   * What this venue's tills may letter themselves in.
   *
   * Unauthenticated and scoped by `office`, as /till/screens is. The till
   * fetches this on startup, downloads anything it has not cached, and keeps
   * working from the cache when this is unreachable.
   */
  router.get('/till/fonts', async (req, res, next) => {
    try {
      const office = String(req.query.office || '').trim();
      if (!office) return res.status(400).json({ error: 'office is required' });
      res.json({ fonts: await catalogueFor(pool, office) });
    } catch (e) {
      next(e);
    }
  });

  /**
   * A font uploaded from the counter.
   *
   * On a terminal token, not on `office` alone. Every other till route here is
   * a read, and an unauthenticated read scoped by a venue's email address is a
   * reasonable trade; an unauthenticated *write* that puts a file on our disk
   * is not, whatever it is scoped by.
   */
  router.post(
    '/till/fonts',
    requireTerminal(secret),
    (req, res, next) => {
      upload.single('font')(req, res, async (err) => {
        if (err) {
          return res.status(400).json({
            error:
              err.code === 'LIMIT_FILE_SIZE'
                ? `That font is larger than ${MAX_BYTES / 1024 / 1024} MB.`
                : 'That upload could not be read.',
          });
        }
        if (!req.file) return res.status(400).json({ error: 'No font was sent.' });

        try {
          const stored = await storeFace(pool, {
            office: req.office,
            file: req.file,
            family: req.body.family,
            weight: req.body.weight,
            by: req.terminal.name || 'a till',
          });
          // Every other till in the venue gets it too. A font installed at one
          // counter and missing at the next is the fault this push prevents.
          broadcast({ type: 'screens', office: req.office }, { office: req.office });
          res.status(201).json(stored);
        } catch (e) {
          if (e.status) return res.status(e.status).json({ error: e.message });
          next(e);
        }
      });
    }
  );

  /**
   * The font this venue's tills wear, changed from a till.
   *
   * A venue-wide setting written from a counter, which is unusual enough to say
   * why: the manager who wants to see whether the brand font is legible across
   * a bar is standing at the bar, not at a desk. Making them walk to an office,
   * change it, and walk back to look is how a font gets picked badly.
   *
   * Terminal token, and it writes exactly one column. Every till in the venue
   * is told, because a venue lettered two ways is worse than a venue lettered
   * in the wrong font.
   */
  router.put('/till/font', requireTerminal(secret), async (req, res, next) => {
    try {
      const slug = String(req.body?.fontFamily ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .slice(0, 64);

      await pool.execute(
        `INSERT INTO epos_till_settings (office, font_family)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE font_family = VALUES(font_family)`,
        [req.office, slug || null]
      );

      // 'till-settings', not 'screens': this is a settings row, and every till
      // already re-reads that row on this message. The font list has not
      // changed, only which one is chosen.
      broadcast({ type: 'till-settings' }, { office: req.office });
      res.json({ fontFamily: slug || null });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = {
  fontsRoutes,
  tillFontRoutes,
  // Exported for the tests, and for anything that needs to know what a font is
  // without going through a route.
  slugify,
  fontKind,
  catalogueFor,
  BUILT_INS,
  BUILT_IN_SLUGS,
  WEIGHTS,
  MAX_BYTES,
};
