/**
 * File manager.
 *
 * Uploads land in one of two directories, both of which are already excluded
 * from deploy.sh's rsync --delete:
 *
 *   public/app/      installers — exe, msi, msix, apk, dmg, zip
 *   public/uploads/  images and documents
 *
 * That exclusion is load-bearing. Without it a deploy wipes every uploaded
 * file, because rsync --delete removes anything on the server that is not in
 * the source tree — and a 90 MB installer is not in the source tree.
 *
 * External links live in the same table, because the admin's question is "what
 * URL do I paste into the page", and the answer is a URL either way.
 */

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pool } = require('../db');
const { ownScope } = require('../admin-auth');
const { safeUrl } = require('./sanitise');
const {
  formatDate, formatDateTime, bytes, back, readFlash, navCounts, slugify, str, int,
} = require('./util');

const router = express.Router();

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const APP_DIR = path.join(PUBLIC_DIR, 'app');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');

for (const dir of [APP_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Extension allowlist, with the directory and category each lands in.
 *
 * SVG is deliberately absent. An SVG is a document that can carry <script>,
 * and one served from this origin runs with the site's cookies — including the
 * admin session. Anything that needs vector art can upload a PNG or link to a
 * CDN.
 */
const KINDS = {
  // Installers
  exe: ['app', APP_DIR], msi: ['app', APP_DIR], msix: ['app', APP_DIR],
  appx: ['app', APP_DIR], apk: ['app', APP_DIR], aab: ['app', APP_DIR],
  dmg: ['app', APP_DIR], pkg: ['app', APP_DIR], deb: ['app', APP_DIR],
  zip: ['app', APP_DIR],

  // Images
  png: ['image', UPLOAD_DIR], jpg: ['image', UPLOAD_DIR], jpeg: ['image', UPLOAD_DIR],
  gif: ['image', UPLOAD_DIR], webp: ['image', UPLOAD_DIR], avif: ['image', UPLOAD_DIR],
  ico: ['image', UPLOAD_DIR],

  // Documents
  pdf: ['document', UPLOAD_DIR], txt: ['document', UPLOAD_DIR],
  csv: ['document', UPLOAD_DIR], doc: ['document', UPLOAD_DIR],
  docx: ['document', UPLOAD_DIR], xls: ['document', UPLOAD_DIR],
  xlsx: ['document', UPLOAD_DIR],
};

/** Where an uploaded file is reachable from the browser. */
const URL_BASE = { [APP_DIR]: '/app', [UPLOAD_DIR]: '/uploads' };

// 512 MB. An MSIX bundle with three architectures in it clears 300 MB, and a
// limit that rejects the actual artefact is worse than no upload feature.
const MAX_BYTES = 512 * 1024 * 1024;

function extensionOf(name) {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(KINDS, ext) ? ext : null;
}

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const ext = extensionOf(file.originalname);
      cb(null, ext ? KINDS[ext][1] : UPLOAD_DIR);
    },
    filename(req, file, cb) {
      const ext = extensionOf(file.originalname);
      const base = slugify(path.basename(file.originalname, path.extname(file.originalname)), 'file');
      // A short random suffix rather than the raw name: two uploads called
      // "installer.exe" must not overwrite each other, and a filename taken
      // from user input is a path-traversal question nobody needs to answer.
      cb(null, `${base}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
    },
  }),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (!extensionOf(file.originalname)) {
      return cb(new Error(`That file type isn't allowed. Permitted: ${Object.keys(KINDS).join(', ')}.`));
    }
    cb(null, true);
  },
});

/** Pages a file can be attached to. */
const ATTACH_TARGETS = [
  ['', 'Not attached — link only'],
  ['download', 'Download page'],
  ['home', 'Home page'],
  ['pricing', 'Pricing page'],
  ['about', 'About page'],
  ['help', 'Support page'],
  ['blog', 'Blog'],
];

// ---- List -----------------------------------------------------------------

router.get('/files', async (req, res, next) => {
  try {
    const category = ['app', 'image', 'document', 'other'].includes(req.query.category)
      ? req.query.category
      : '';
    const q = str(req.query.q, 120);

    const where = [];
    const params = [];
    if (category) { where.push('category = ?'); params.push(category); }
    if (q) { where.push('(title LIKE ? OR original_name LIKE ? OR url LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

    // A contributor sees the files they uploaded and no others — including in
    // the totals across the top, which would otherwise report the whole
    // library's size to somebody who can see three rows of it.
    const mine = ownScope(req.admin);
    if (mine.sql) { where.push('owner_admin_id = ?'); params.push(...mine.params); }

    const [rows] = await pool.query(
      `SELECT * FROM media_files
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC`,
      params
    );

    const [[stats]] = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS total_bytes,
              COALESCE(SUM(download_count), 0) AS downloads
       FROM media_files
       WHERE 1 = 1${mine.sql}`,
      mine.params
    );

    res.render('admin/files', {
      title: 'File Manager | Vesopa Admin',
      heading: 'File Manager',
      nav: 'files',
      counts: await navCounts(),
      flash: readFlash(req),
      rows, stats, category, q,
      attachTargets: ATTACH_TARGETS,
      allowed: Object.keys(KINDS),
      maxLabel: bytes(MAX_BYTES),
      bytes, formatDate, formatDateTime,
    });
  } catch (e) {
    next(e);
  }
});

// ---- Upload ---------------------------------------------------------------

router.post('/files/upload', (req, res, next) => {
  upload.single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      // multer's own message for an oversize file is "File too large", which
      // tells the admin nothing about what the limit is.
      const message =
        uploadError.code === 'LIMIT_FILE_SIZE'
          ? `That file is over the ${bytes(MAX_BYTES)} limit.`
          : uploadError.message;
      return back(res, '/admin/files', { err: message });
    }
    if (!req.file) return back(res, '/admin/files', { err: 'No file was chosen.' });

    const ext = extensionOf(req.file.originalname);
    const [category, dir] = KINDS[ext];
    const url = `${URL_BASE[dir]}/${req.file.filename}`;

    try {
      await pool.query(
        `INSERT INTO media_files
           (kind, category, title, original_name, stored_name, url, mime, size_bytes,
            attach_to, label, version, is_public, sort_order, uploaded_by,
            owner_admin_id)
         VALUES ('file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          category,
          str(req.body.title, 255) || req.file.originalname,
          req.file.originalname,
          req.file.filename,
          url,
          req.file.mimetype,
          req.file.size,
          str(req.body.attach_to, 64) || null,
          str(req.body.label, 255) || null,
          str(req.body.version, 32) || null,
          req.body.is_public === '0' ? 0 : 1,
          int(req.body.sort_order, 0),
          req.admin.fullname || req.admin.username,
          // Who may edit it later, which is a different question from the
          // `uploaded_by` byline beside it — that one is free text.
          req.admin.id,
        ]
      );

      back(res, '/admin/files', {
        ok: `${req.file.originalname} uploaded — ${bytes(req.file.size)}.`,
      });
    } catch (e) {
      // The row failed but the bytes are on disk; leaving them there would
      // accumulate files nothing points at.
      await fsp.unlink(req.file.path).catch(() => {});
      next(e);
    }
  });
});

// ---- External link --------------------------------------------------------

router.post('/files/link', async (req, res, next) => {
  const url = safeUrl(str(req.body.url, 700));
  const title = str(req.body.title, 255);

  if (!url) {
    return back(res, '/admin/files', {
      err: 'That URL is not usable — it must start with http://, https:// or /.',
    });
  }
  if (!title) return back(res, '/admin/files', { err: 'Give the link a title.' });

  try {
    await pool.query(
      `INSERT INTO media_files
         (kind, category, title, url, attach_to, label, version, is_public, sort_order,
          uploaded_by, owner_admin_id)
       VALUES ('link', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ['app', 'image', 'document', 'other'].includes(req.body.category)
          ? req.body.category
          : 'other',
        title,
        url,
        str(req.body.attach_to, 64) || null,
        str(req.body.label, 255) || null,
        str(req.body.version, 32) || null,
        req.body.is_public === '0' ? 0 : 1,
        int(req.body.sort_order, 0),
        req.admin.fullname || req.admin.username,
        req.admin.id,
      ]
    );
    back(res, '/admin/files', { ok: 'Link saved.' });
  } catch (e) {
    next(e);
  }
});

// ---- Edit / delete --------------------------------------------------------

router.post('/files/:id', async (req, res, next) => {
  const id = int(req.params.id, 0);
  // In the WHERE, not in a check before it. A read-then-write leaves a window
  // between the two, and there is nothing here that a single statement cannot
  // express: a contributor's UPDATE simply matches no row unless it is theirs.
  const mine = ownScope(req.admin);
  try {
    await pool.query(
      `UPDATE media_files SET title = ?, attach_to = ?, label = ?, version = ?,
                              is_public = ?, sort_order = ?, category = ?
       WHERE id = ?${mine.sql}`,
      [
        str(req.body.title, 255),
        str(req.body.attach_to, 64) || null,
        str(req.body.label, 255) || null,
        str(req.body.version, 32) || null,
        req.body.is_public === '0' ? 0 : 1,
        int(req.body.sort_order, 0),
        ['app', 'image', 'document', 'other'].includes(req.body.category)
          ? req.body.category
          : 'other',
        id,
        ...mine.params,
      ]
    );
    back(res, '/admin/files', { ok: 'Saved.' });
  } catch (e) {
    next(e);
  }
});

router.post('/files/:id/delete', async (req, res, next) => {
  const id = int(req.params.id, 0);
  const mine = ownScope(req.admin);

  try {
    // Scoped on the way in as well as on the way out. Without it on the SELECT,
    // a contributor could not delete somebody else's file but could still learn
    // its name and stored path from the message this hands back.
    const [[file]] = await pool.query(
      `SELECT kind, stored_name, url, title FROM media_files WHERE id = ?${mine.sql}`,
      [id, ...mine.params]
    );
    if (!file) return back(res, '/admin/files', { err: 'That file is already gone.' });

    await pool.query(`DELETE FROM media_files WHERE id = ?${mine.sql}`, [id, ...mine.params]);

    if (file.kind === 'file' && file.stored_name) {
      // Rebuilt from the base directory and the stored basename rather than
      // taken from the url column, so a doctored row cannot unlink something
      // outside these two directories.
      const dir = file.url.startsWith('/app/') ? APP_DIR : UPLOAD_DIR;
      const target = path.join(dir, path.basename(file.stored_name));
      if (target.startsWith(dir + path.sep)) {
        await fsp.unlink(target).catch(() => {});
      }
    }

    back(res, '/admin/files', { ok: `${file.title} deleted.` });
  } catch (e) {
    next(e);
  }
});

// ---- Reads used elsewhere -------------------------------------------------

/** Public files attached to a page, for the templates to render. */
async function filesFor(page) {
  const [rows] = await pool.query(
    `SELECT id, title, url, label, version, category, size_bytes, kind
     FROM media_files
     WHERE attach_to = ? AND is_public = 1
     ORDER BY sort_order, created_at DESC`,
    [page]
  );
  return rows;
}

module.exports = { filesRouter: router, filesFor, APP_DIR, UPLOAD_DIR };
