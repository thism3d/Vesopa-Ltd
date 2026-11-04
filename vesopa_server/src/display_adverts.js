/**
 * Pictures and films for customer displays, kept in the back office
 * (2026-11-03).
 *
 * The Windows customer display plays what is in a folder on its own PC. A
 * Vesopa Go device running as a customer display has no such folder, and the
 * owner asked for "display adverts and video" on it. So the venue uploads
 * them here (Devices › Customer display adverts) and every Go display plays
 * them between sales, in the order set here.
 *
 *   GET    /api/display-adverts            the back office: the list
 *   POST   /api/display-adverts            the back office: one file (multipart "file")
 *   PUT    /api/display-adverts/order      the back office: { ids: [...] }
 *   DELETE /api/display-adverts/:id        the back office
 *   GET    /api/display/adverts            a display (display token): what to play
 *
 * Files go to public/uploads/display-adverts under a random name, after they
 * have been looked at (memory storage, as fonts.js explains), so a refused
 * upload never sits in a served folder.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { attachAccess, requirePermission } = require('./permissions');

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'display-adverts');
const MAX_BYTES = 80 * 1024 * 1024;
const MAX_ADVERTS = 40;
const KINDS = {
  'image/png': ['png', 'image'],
  'image/jpeg': ['jpg', 'image'],
  'image/webp': ['webp', 'image'],
  'image/gif': ['gif', 'image'],
  'video/mp4': ['mp4', 'video'],
  'video/quicktime': ['mov', 'video'],
  'video/x-m4v': ['m4v', 'video'],
};

/** What a file really is, from its first bytes, not from what the browser said. */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii');
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand.startsWith('M4V')) return 'video/x-m4v';
    return 'video/mp4';
  }
  return null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

function displayAdvertRoutes({ pool, secret, auth }) {
  const router = express.Router();
  const edit = [auth, attachAccess({ pool }), requirePermission('programming.devices')];

  let ready = null;
  function ensure() {
    ready ||= pool.query(`CREATE TABLE IF NOT EXISTS epos_display_adverts (
        id VARCHAR(32) NOT NULL PRIMARY KEY,
        office VARCHAR(191) NOT NULL,
        file_name VARCHAR(80) NOT NULL,
        kind VARCHAR(8) NOT NULL,
        title VARCHAR(160) NULL,
        byte_size INT NOT NULL DEFAULT 0,
        position INT NOT NULL DEFAULT 0,
        seconds INT NOT NULL DEFAULT 10,
        created_by VARCHAR(191) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY office_position (office, position)
      )`).catch((e) => { ready = null; throw e; });
    return ready;
  }

  async function officeOf(req) {
    if (req.user.officeId) {
      const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (o) return o.contact_email;
    }
    return req.user.email;
  }

  const view = (r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title || null,
    url: `/uploads/display-adverts/${r.file_name}`,
    bytes: Number(r.byte_size) || 0,
    seconds: Number(r.seconds) || 10,
  });

  async function listFor(office) {
    await ensure();
    const [rows] = await pool.query(
      'SELECT * FROM epos_display_adverts WHERE office = ? ORDER BY position, created_at', [office]);
    return rows.map(view);
  }

  router.get('/api/display-adverts', auth, async (req, res, next) => {
    try {
      res.json({ adverts: await listFor(await officeOf(req)), max_bytes: MAX_BYTES });
    } catch (e) { next(e); }
  });

  router.post('/api/display-adverts', ...edit, (req, res, next) => {
    upload.single('file')(req, res, async (err) => {
      try {
        if (err) {
          return res.status(400).json({
            error: err.code === 'LIMIT_FILE_SIZE' ? `That file is over ${MAX_BYTES / 1024 / 1024} MB.` : 'That upload did not arrive.',
          });
        }
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'Choose a picture or a film to upload.' });
        const type = sniff(file.buffer);
        if (!type || !KINDS[type]) {
          return res.status(400).json({ error: 'Pictures (PNG, JPEG, WebP, GIF) and films (MP4, MOV) only.' });
        }
        const office = await officeOf(req);
        await ensure();
        const [[count]] = await pool.query('SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS top FROM epos_display_adverts WHERE office = ?', [office]);
        if (Number(count.n) >= MAX_ADVERTS) return res.status(409).json({ error: `A venue can keep ${MAX_ADVERTS} adverts. Delete one first.` });
        const [ext, kind] = KINDS[type];
        const id = crypto.randomBytes(16).toString('hex');
        const fileName = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        fs.writeFileSync(path.join(UPLOAD_DIR, fileName), file.buffer);
        const title = String((req.body && req.body.title) || file.originalname || '').slice(0, 160) || null;
        const seconds = Math.min(120, Math.max(3, Number((req.body && req.body.seconds) || 10) || 10));
        await pool.query(
          `INSERT INTO epos_display_adverts (id, office, file_name, kind, title, byte_size, position, seconds, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, office, fileName, kind, title, file.size, Number(count.top) + 1, seconds, String(req.user.email || '').slice(0, 191)]);
        res.status(201).json(view({ id, kind, title, file_name: fileName, byte_size: file.size, seconds }));
      } catch (e) { next(e); }
    });
  });

  router.put('/api/display-adverts/order', ...edit, express.json(), async (req, res, next) => {
    try {
      const office = await officeOf(req);
      const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map((x) => String(x).slice(0, 32)) : [];
      await ensure();
      for (const [i, id] of ids.entries()) {
        await pool.query('UPDATE epos_display_adverts SET position = ? WHERE id = ? AND office = ?', [i + 1, id, office]);
      }
      res.json({ adverts: await listFor(office) });
    } catch (e) { next(e); }
  });

  router.delete('/api/display-adverts/:id', ...edit, async (req, res, next) => {
    try {
      const office = await officeOf(req);
      await ensure();
      const [[row]] = await pool.query('SELECT file_name FROM epos_display_adverts WHERE id = ? AND office = ?', [String(req.params.id).slice(0, 32), office]);
      if (!row) return res.status(404).json({ error: 'That advert has gone already.' });
      await pool.query('DELETE FROM epos_display_adverts WHERE id = ? AND office = ?', [String(req.params.id).slice(0, 32), office]);
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, row.file_name));
      } catch {
        // already gone: the row was the thing that mattered
      }
      res.status(204).end();
    } catch (e) { next(e); }
  });

  /** What a customer display plays, for its venue only. */
  router.get('/api/display/adverts', async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      let claims;
      try {
        claims = jwt.verify(header.startsWith('Bearer ') ? header.slice(7) : '', secret);
      } catch {
        return res.status(401).json({ error: 'This display needs to be signed in again.' });
      }
      if (claims.scope !== 'display' || !claims.office) return res.status(401).json({ error: 'Not a display token' });
      res.set('Cache-Control', 'no-store');
      res.json({ adverts: await listFor(claims.office) });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { displayAdvertRoutes, sniff };
