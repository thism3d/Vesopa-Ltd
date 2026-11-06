/**
 * Printer drives: every printer gets a place online, and what goes in it prints
 * on that printer (owner, 2026-11-06: "every venue documents and pdf printing
 * should go to the live drive of that specific printer").
 *
 * A DRIVE is one printer on one terminal. Documents go in from the back office,
 * or from anybody holding the drive's private link, on any phone or computer.
 * That terminal is the connector: it asks what is waiting, prints it through the
 * same road its receipts take, and says how it went.
 *
 * FROM ANYWHERE. Each drive is also a printer on the internet (src/ipp.js): an
 * iPhone given its address prints to it from any connection, and the document
 * lands here like any other. Android has no way to add a printer by a full web
 * address, so there the drive's page installs and appears in the Share menu.
 * The long code in the address is what stands between a stranger and the paper.
 *
 * DOCUMENTS WAIT. A till that is off or offline finds them when it comes back.
 *
 * NEVER PRINTED TWICE ON ITS OWN. A job a terminal took and never answered for
 * is marked failed, not put back: only a person can send it again, because the
 * paper may well have come out.
 *
 * PDF, PNG and JPEG only, decided by the file's own bytes and not its name.
 * Files are kept out of the public folder, and go a week after they finish.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');

const ipp = require('./ipp');
const { attachAccess, requirePermission } = require('./permissions');
const { requireDevice } = require('./terminal_licences');

const MAX_BYTES = 25 * 1024 * 1024;
const KEEP_DAYS = 7;
const NO_ANSWER_MINUTES = 10;
const BASE = process.env.PRINT_DRIVE_DIR || path.join(__dirname, '..', 'data', 'print-drive');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 10 } });
const clamp = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const asInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What a file really is, from its first bytes, or null if it is not one we print. */
function sniffType(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (bytes.subarray(0, 7).toString('latin1') === 'UNIRAST') return 'image/urf';
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

/** A name safe to show and to send in a header. */
function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  return clamp(base.replace(/[^\w .()-]/g, '_'), 120) || 'document';
}

/** Where a job may go next. Anything else is refused, so a late answer cannot undo a result. */
const NEXT = { waiting: ['printing', 'cancelled'], printing: ['printed', 'failed'], failed: ['waiting'], cancelled: ['waiting'], printed: ['waiting'] };
const mayMove = (from, to) => (NEXT[from] || []).includes(to);

/** The printers a terminal last reported, from its settings (terminal_sync.dart). */
function printersOf(value) {
  let list = value;
  try { if (typeof value === 'string') list = JSON.parse(value); } catch { list = null; }
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && p.id).map((p) => ({ id: String(p.id), name: String(p.name || p.id) }));
}

function testPage(driveName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 60 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(26).text('Vesopa printer drive');
    doc.moveDown().fontSize(14).text(`This is a test page for ${driveName}.`);
    doc.moveDown().text(`Sent ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`);
    doc.moveDown().text('If you can read this, documents put in this drive print here.');
    doc.end();
  });
}

function printDriveRoutes({ pool, secret, auth, requireAdmin, broadcast }) {
  const router = express.Router();
  const device = requireDevice(secret);

  let ready = null;
  function ensure() {
    ready ||= (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS bo_print_drives (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        office VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
        name VARCHAR(80) NOT NULL,
        terminal_id INT NOT NULL,
        printer_id VARCHAR(64) NOT NULL,
        printer_name VARCHAR(120) NULL,
        code CHAR(32) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        deleted_at DATETIME NULL,
        created_by VARCHAR(191) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_print_code (code),
        KEY ix_print_office (office),
        KEY ix_print_terminal (terminal_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS bo_print_jobs (
        id CHAR(32) NOT NULL PRIMARY KEY,
        drive_id INT NOT NULL,
        office VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
        filename VARCHAR(120) NOT NULL,
        mime VARCHAR(32) NOT NULL,
        size INT NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'waiting',
        error VARCHAR(240) NULL,
        sent_by VARCHAR(120) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        taken_at DATETIME NULL,
        finished_at DATETIME NULL,
        KEY ix_job_drive (drive_id, status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      // Whether phones on the venue's network can find this printer. Off until a
      // manager says, because anybody on that Wi-Fi could then print to it.
      await pool.query('ALTER TABLE bo_print_drives ADD COLUMN IF NOT EXISTS phones TINYINT(1) NOT NULL DEFAULT 0');
    })().catch((e) => {
      ready = null;
      throw e;
    });
    return ready;
  }

  const fileOf = (job) => path.join(BASE, String(job.office).replace(/[^\w.@-]/g, '_'), job.id);
  const say = (office) => { if (broadcast) broadcast({ type: 'print-drive.updated' }, { office }); };

  async function addJob(drive, { bytes, filename, sentBy }) {
    const mime = sniffType(bytes);
    if (!mime) {
      const e = new Error('Only PDF, PNG and JPEG files can be printed.');
      e.status = 415;
      throw e;
    }
    const job = { id: crypto.randomBytes(16).toString('hex'), office: drive.office };
    await fs.promises.mkdir(path.dirname(fileOf(job)), { recursive: true });
    await fs.promises.writeFile(fileOf(job), bytes);
    await pool.execute(
      `INSERT INTO bo_print_jobs (id, drive_id, office, filename, mime, size, sent_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [job.id, drive.id, drive.office, safeName(filename), mime, bytes.length, clamp(sentBy, 120) || null]
    );
    say(drive.office);
    return job.id;
  }

  async function drivesOf(office) {
    await ensure();
    const [rows] = await pool.query(
      `SELECT d.*, t.name AS terminal_name, t.terminal_no, t.last_ping_at,
              (SELECT COUNT(*) FROM bo_print_jobs j WHERE j.drive_id = d.id AND j.status = 'waiting') AS waiting
         FROM bo_print_drives d LEFT JOIN bo_terminals t ON t.id = d.terminal_id
        WHERE d.office = ? AND d.deleted_at IS NULL ORDER BY d.name`,
      [office]
    );
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      terminal_id: d.terminal_id,
      terminal: d.terminal_name || (d.terminal_no ? `Terminal ${d.terminal_no}` : null),
      online: d.last_ping_at ? Date.now() - new Date(d.last_ping_at).getTime() < 15 * 60 * 1000 : false,
      printer_id: d.printer_id,
      printer_name: d.printer_name,
      enabled: Boolean(Number(d.enabled)),
      phones: Boolean(Number(d.phones)),
      waiting: Number(d.waiting),
      link: `/print/${d.code}`,
    }));
  }

  /** The tills a drive can sit on, with the printers each one has. */
  async function connectorsOf(office) {
    await ensure();
    const [rows] = await pool.query(
      `SELECT t.id, t.name, t.device_name, t.terminal_no, s.value
         FROM bo_terminals t
         LEFT JOIN bo_terminal_settings s
           ON s.terminal_id = t.id AND s.category = 'Printers' AND s.name = 'vesopa_printers#printers'
        WHERE t.office = ? AND t.kind = 'till' AND t.revoked_at IS NULL ORDER BY t.terminal_no`,
      [office]
    );
    return rows.map((t) => ({
      id: t.id,
      name: t.name || t.device_name || `Terminal ${t.terminal_no}`,
      printers: printersOf(t.value),
    }));
  }

  async function driveOf(office, id) {
    await ensure();
    const [[d]] = await pool.query(
      'SELECT * FROM bo_print_drives WHERE id = ? AND office = ? AND deleted_at IS NULL', [id, office]);
    return d || null;
  }

  async function jobOf(office, id) {
    await ensure();
    const [[j]] = await pool.query('SELECT * FROM bo_print_jobs WHERE id = ? AND office = ?', [id, office]);
    return j || null;
  }

  async function move(job, to, error) {
    if (!mayMove(job.status, to)) return false;
    const [r] = await pool.execute(
      `UPDATE bo_print_jobs
          SET status = ?, error = ?,
              taken_at = IF(? = 'printing', NOW(), taken_at),
              finished_at = IF(? IN ('printed', 'failed', 'cancelled'), NOW(), NULL)
        WHERE id = ? AND status = ?`,
      [to, error || null, to, to, job.id, job.status]
    );
    if (r.affectedRows) say(job.office);
    return r.affectedRows > 0;
  }

  /** A job taken and never answered for. Marked, never reprinted by itself. */
  async function settleSilent(office) {
    await pool.execute(
      `UPDATE bo_print_jobs
          SET status = 'failed', error = 'The till did not say whether this printed. Check before sending it again.',
              finished_at = NOW()
        WHERE office = ? AND status = 'printing' AND taken_at < NOW() - INTERVAL ? MINUTE`,
      [office, NO_ANSWER_MINUTES]
    );
  }

  function pages(sub, officeOf, guard, { uploads }) {
    const office = async (req, res) => {
      const o = await officeOf(req);
      if (!o) res.status(404).json({ error: 'No such venue' });
      return o;
    };
    const who = (req) => (req.user && req.user.email) || null;

    sub.get('/', guard, async (req, res, next) => {
      try {
        const o = await office(req, res);
        if (!o) return;
        await ensure();
        await settleSilent(o);
        res.json({ drives: await drivesOf(o), connectors: await connectorsOf(o) });
      } catch (e) { next(e); }
    });

    sub.post('/', guard, express.json(), async (req, res, next) => {
      try {
        const o = await office(req, res);
        if (!o) return;
        const b = req.body || {};
        const connector = (await connectorsOf(o)).find((c) => c.id === asInt(b.terminal_id));
        const printer = connector && connector.printers.find((p) => p.id === clamp(b.printer_id, 64));
        const name = clamp(b.name, 80);
        if (!name || !printer) return res.status(400).json({ error: 'Choose a name, a till and one of its printers.' });
        const code = crypto.randomBytes(16).toString('hex');
        const [r] = await pool.execute(
          `INSERT INTO bo_print_drives (office, name, terminal_id, printer_id, printer_name, code, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [o, name, connector.id, printer.id, printer.name, code, who(req)]
        );
        res.status(201).json({ id: r.insertId, link: `/print/${code}` });
      } catch (e) { next(e); }
    });

    sub.put('/:id', guard, express.json(), async (req, res, next) => {
      try {
        const o = await office(req, res);
        if (!o) return;
        const d = await driveOf(o, asInt(req.params.id));
        if (!d) return res.status(404).json({ error: 'No such drive' });
        await pool.execute('UPDATE bo_print_drives SET phones = ? WHERE id = ?', [(req.body || {}).phones ? 1 : 0, d.id]);
        res.json({ ok: true });
      } catch (e) { next(e); }
    });

    sub.delete('/:id', guard, async (req, res, next) => {
      try {
        const o = await office(req, res);
        if (!o) return;
        const d = await driveOf(o, asInt(req.params.id));
        if (!d) return res.status(404).json({ error: 'No such drive' });
        // The link stops at once; what was already printed stays in the history.
        await pool.execute('UPDATE bo_print_drives SET deleted_at = NOW(), enabled = 0 WHERE id = ?', [d.id]);
        res.json({ ok: true });
      } catch (e) { next(e); }
    });

    sub.post('/:id/link', guard, async (req, res, next) => {
      try {
        const o = await office(req, res);
        if (!o) return;
        const d = await driveOf(o, asInt(req.params.id));
        if (!d) return res.status(404).json({ error: 'No such drive' });
        const code = crypto.randomBytes(16).toString('hex');
        await pool.execute('UPDATE bo_print_drives SET code = ? WHERE id = ?', [code, d.id]);
        res.json({ link: `/print/${code}` });
      } catch (e) { next(e); }
    });

    sub.get('/:id/jobs', guard, async (req, res, next) => {
      try {
        const o = await office(req, res);
        if (!o) return;
        const d = await driveOf(o, asInt(req.params.id));
        if (!d) return res.status(404).json({ error: 'No such drive' });
        const [jobs] = await pool.query(
          `SELECT id, filename, size, status, error, sent_by, created_at, finished_at
             FROM bo_print_jobs WHERE drive_id = ? ORDER BY created_at DESC LIMIT 100`, [d.id]);
        res.json({ jobs });
      } catch (e) { next(e); }
    });

    sub.post('/:id/test', guard, async (req, res, next) => {
      try {
        const o = await office(req, res);
        if (!o) return;
        const d = await driveOf(o, asInt(req.params.id));
        if (!d) return res.status(404).json({ error: 'No such drive' });
        const job = await addJob(d, { bytes: await testPage(d.name), filename: 'Test page.pdf', sentBy: who(req) });
        res.status(201).json({ id: job });
      } catch (e) { next(e); }
    });

    if (uploads) {
      sub.post('/:id/jobs', guard, upload.array('files', 10), async (req, res, next) => {
        try {
          const o = await office(req, res);
          if (!o) return;
          const d = await driveOf(o, asInt(req.params.id));
          if (!d) return res.status(404).json({ error: 'No such drive' });
          const ids = [];
          for (const f of req.files || []) {
            ids.push(await addJob(d, { bytes: f.buffer, filename: f.originalname, sentBy: who(req) }));
          }
          res.status(201).json({ ids });
        } catch (e) {
          if (e.status) return res.status(e.status).json({ error: e.message });
          next(e);
        }
      });
    }

    sub.post('/jobs/:job/:action', guard, async (req, res, next) => {
      try {
        const o = await office(req, res);
        if (!o) return;
        const job = await jobOf(o, clamp(req.params.job, 32));
        if (!job) return res.status(404).json({ error: 'No such job' });
        const to = { cancel: 'cancelled', again: 'waiting' }[req.params.action];
        if (job.mime === 'local') return res.status(409).json({ error: 'That was printed from a phone, so there is no copy here.' });
        if (!to || !(await move(job, to))) return res.status(409).json({ error: 'That job cannot do that now.' });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }

  const venue = express.Router();
  pages(venue, async (req) => {
    const [[row]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
    return row ? row.contact_email : null;
  }, [auth, attachAccess({ pool }), requirePermission('programming.devices')], { uploads: true });
  router.use('/api/print-drives', venue);

  const admin = express.Router({ mergeParams: true });
  pages(admin, async (req) => {
    const [[row]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.params.officeId]);
    return row ? row.contact_email : null;
  }, [auth, requireAdmin], { uploads: false });
  router.use('/api/admin/offices/:officeId/print-drives', admin);

  // ---- The connector ------------------------------------------------------

  async function terminalIdOf(office, deviceId, kind) {
    const [[row]] = await pool.query(
      'SELECT id FROM bo_terminals WHERE office = ? AND device_id = ? AND kind = ? AND revoked_at IS NULL',
      [office, deviceId, kind]
    );
    return row ? row.id : null;
  }

  /** What is waiting for this device. Marked as taken only when it asks for the file. */
  router.get('/api/device/print-jobs', device, async (req, res, next) => {
    try {
      await ensure();
      const id = await terminalIdOf(req.office, clamp(req.query.device_id, 64), req.deviceKind);
      if (!id) return res.json({ jobs: [] });
      await settleSilent(req.office);
      const [jobs] = await pool.query(
        `SELECT j.id, j.filename, j.mime, d.printer_id
           FROM bo_print_jobs j JOIN bo_print_drives d ON d.id = j.drive_id
          WHERE d.terminal_id = ? AND d.enabled = 1 AND d.deleted_at IS NULL AND j.status = 'waiting'
          ORDER BY j.created_at LIMIT 10`,
        [id]
      );
      res.json({ jobs });
    } catch (e) { next(e); }
  });

  /** The drives this device holds, so it can offer the ones phones may use. */
  router.get('/api/device/print-drives', device, async (req, res, next) => {
    try {
      await ensure();
      const id = await terminalIdOf(req.office, clamp(req.query.device_id, 64), req.deviceKind);
      if (!id) return res.json({ drives: [] });
      const [drives] = await pool.query(
        `SELECT id, name, printer_id FROM bo_print_drives
          WHERE terminal_id = ? AND enabled = 1 AND phones = 1 AND deleted_at IS NULL`, [id]);
      res.json({ drives });
    } catch (e) { next(e); }
  });

  /**
   * A document a phone printed straight to this till. For the history only: it
   * has no file here, so it cannot be sent again from the back office.
   */
  router.post('/api/device/print-jobs/local', express.json(), device, async (req, res, next) => {
    try {
      await ensure();
      const b = req.body || {};
      const id = await terminalIdOf(req.office, clamp(b.device_id, 64), req.deviceKind);
      const [[d]] = await pool.query(
        'SELECT id, office FROM bo_print_drives WHERE id = ? AND terminal_id = ? AND deleted_at IS NULL', [asInt(b.drive_id), id]);
      if (!d) return res.status(404).json({ error: 'No such drive' });
      await pool.execute(
        `INSERT INTO bo_print_jobs (id, drive_id, office, filename, mime, size, status, error, sent_by, finished_at)
         VALUES (?, ?, ?, ?, 'local', 0, ?, ?, 'Phone on the network', NOW())`,
        [crypto.randomBytes(16).toString('hex'), d.id, d.office, safeName(b.filename),
          b.printed === true ? 'printed' : 'failed', b.printed === true ? null : clamp(b.error, 240) || null]
      );
      say(d.office);
      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  });

  router.get('/api/device/print-jobs/:id/file', device, async (req, res, next) => {
    try {
      const job = await jobOf(req.office, clamp(req.params.id, 32));
      if (!job) return res.status(404).json({ error: 'No such job' });
      if (!(await move(job, 'printing'))) return res.status(409).json({ error: 'That job is not waiting.' });
      res.type(job.mime).sendFile(path.resolve(fileOf(job)));
    } catch (e) { next(e); }
  });

  router.post('/api/device/print-jobs/:id/status', express.json(), device, async (req, res, next) => {
    try {
      const job = await jobOf(req.office, clamp(req.params.id, 32));
      if (!job) return res.status(404).json({ error: 'No such job' });
      const to = (req.body || {}).printed === true ? 'printed' : 'failed';
      if (!(await move(job, to, to === 'failed' ? clamp(req.body.error, 240) : null))) {
        return res.status(409).json({ error: 'That job has already finished.' });
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- The drive's own page, for anybody holding its link -------------------

  const sends = new Map();
  const tooMany = (code) => {
    const recent = (sends.get(code) || []).filter((t) => Date.now() - t < 3600e3);
    recent.push(Date.now());
    sends.set(code, recent);
    return recent.length > 60;
  };

  const page = (title, body) => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
body{margin:0;background:#0b0e0a;color:#f2efe6;font:16px/1.5 system-ui,sans-serif;display:flex;justify-content:center;padding:24px 16px}
main{width:100%;max-width:440px}h1{font-size:24px;margin:0 0 4px}p{color:#b9b9b0;margin:0 0 20px}
label.drop{display:block;border:2px dashed #a5c715;border-radius:14px;padding:36px 16px;text-align:center;cursor:pointer;margin-bottom:14px}
input[type=file]{display:block;width:100%;margin-top:12px}input[type=text]{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #444;background:#15190f;color:#fff;font:inherit;margin-bottom:14px}
button{width:100%;padding:14px;border:0;border-radius:12px;background:#a5c715;color:#0b0e0a;font:inherit;font-weight:700}
</style></head><body><main>${body}</main></body></html>`;

  async function driveByCode(code) {
    if (!/^[0-9a-f]{32}$/.test(code)) return null;
    await ensure();
    const [[d]] = await pool.query(
      'SELECT * FROM bo_print_drives WHERE code = ? AND enabled = 1 AND deleted_at IS NULL', [code]);
    return d || null;
  }

  router.get('/print/:code', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const d = await driveByCode(String(req.params.code));
      if (!d) return res.status(404).type('html').send(page('Not found', '<h1>This printer link is not known</h1><p>Ask the venue for a new one.</p>'));
      res.type('html').send(page(`Print to ${d.name}`, `<h1>Print to ${esc(d.name)}</h1>
<p>Choose a PDF or a picture and it prints there.</p>
<link rel="manifest" href="/print/${esc(d.code)}/manifest.webmanifest">
<form method="post" enctype="multipart/form-data" action="/print/${esc(d.code)}">
<label class="drop">Choose files<input type="file" name="files" multiple required accept="application/pdf,image/png,image/jpeg"></label>
<input type="text" name="sender" maxlength="120" placeholder="Your name (optional)">
<button>Print</button></form>
<h2 style="font-size:17px;margin:28px 0 6px">Keep this printer on your phone</h2>
<p><a style="color:#a5c715" href="/print/${esc(d.code)}/airprint.mobileconfig">iPhone or iPad: add it to the Print menu</a>. Open Settings when it says so, and install the profile.</p>
<p>Android: use your browser's menu and choose Install app or Add to Home screen. Then choose Share on any document and pick this printer.</p>`));
    } catch (e) { next(e); }
  });

  /** So Android offers the drive in its Share menu. */
  router.get('/print/:code/manifest.webmanifest', async (req, res, next) => {
    try {
      const d = await driveByCode(String(req.params.code));
      if (!d) return res.status(404).end();
      res.set('Cache-Control', 'no-store');
      res.type('application/manifest+json').send(JSON.stringify({
        name: `Print to ${d.name}`,
        short_name: d.name,
        start_url: `/print/${d.code}`,
        scope: `/print/${d.code}`,
        display: 'standalone',
        background_color: '#0b0e0a',
        theme_color: '#0b0e0a',
        icons: [
          { src: '/print-icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/print-icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
        share_target: {
          action: `/print/${d.code}`,
          method: 'POST',
          enctype: 'multipart/form-data',
          params: { files: [{ name: 'files', accept: ['application/pdf', 'image/png', 'image/jpeg'] }] },
        },
      }));
    } catch (e) { next(e); }
  });

  /** The profile that puts this printer in an iPhone's Print menu, anywhere. */
  router.get('/print/:code/airprint.mobileconfig', async (req, res, next) => {
    try {
      const d = await driveByCode(String(req.params.code));
      if (!d) return res.status(404).end();
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', 'attachment; filename="vesopa-printer.mobileconfig"');
      res.type('application/x-apple-aspen-config').send(ipp.airPrintProfile({
        name: `Vesopa ${d.name}`,
        host: req.hostname,
        path: `ipp/print/${d.code}`,
        seed: d.code,
      }));
    } catch (e) { next(e); }
  });

  // What phones have sent, by drive, for the few moments a phone asks after it.
  const phoneJobs = new Map();

  /** The drive as a printer on the internet. */
  router.post('/ipp/print/:code', express.raw({ type: () => true, limit: MAX_BYTES + 1024 * 1024 }), async (req, res, next) => {
    try {
      const code = String(req.params.code);
      const d = await driveByCode(code);
      if (!d) return res.status(404).end();
      if (!phoneJobs.has(code)) {
        if (phoneJobs.size > 500) phoneJobs.clear();
        phoneJobs.set(code, {});
      }
      const answer = await ipp.respond(req.body, {
        name: `Vesopa ${d.name}`,
        uri: `ipps://${req.hostname}/ipp/print/${code}`,
        uuid: ipp.uuidFor(code),
        secure: true,
      }, phoneJobs.get(code), async (bytes, name) => {
        if (tooMany(code)) throw Object.assign(new Error('Too many documents'), { status: 415 });
        await addJob(d, { bytes, filename: name, sentBy: 'Phone, over the internet' });
      });
      res.type('application/ipp').send(answer);
    } catch (e) { next(e); }
  });

  router.post('/print/:code', upload.array('files', 10), async (req, res, next) => {
    try {
      const code = String(req.params.code);
      const d = await driveByCode(code);
      if (!d) return res.status(404).type('html').send(page('Not found', '<h1>This printer link is not known</h1>'));
      if (tooMany(code)) return res.status(429).type('html').send(page('Too many', '<h1>Too many documents</h1><p>Try again in a while.</p>'));
      const files = req.files || [];
      if (!files.length) return res.redirect(303, `/print/${code}`);
      for (const f of files) {
        await addJob(d, { bytes: f.buffer, filename: f.originalname, sentBy: clamp((req.body || {}).sender, 120) || 'Web link' });
      }
      res.type('html').send(page('Sent', `<h1>Sent to ${esc(d.name)}</h1><p>${files.length === 1 ? 'Your document is' : `${files.length} documents are`} on the way to the printer.</p>
<form action="/print/${esc(code)}"><button>Print something else</button></form>`));
    } catch (e) {
      if (e.status) return res.status(e.status).type('html').send(page('Not printed', `<h1>Not printed</h1><p>${esc(e.message)}</p>`));
      next(e);
    }
  });

  // Finished files go after a week. The history stays.
  const sweep = async () => {
    try {
      await ensure();
      const [old] = await pool.query(
        `SELECT id, office FROM bo_print_jobs
          WHERE status IN ('printed', 'failed', 'cancelled') AND finished_at < NOW() - INTERVAL ? DAY`, [KEEP_DAYS]);
      for (const job of old) await fs.promises.rm(fileOf(job), { force: true });
    } catch (e) {
      console.warn('[print_drive] sweep:', e.message);
    }
  };
  setInterval(sweep, 6 * 3600e3).unref();

  return router;
}

module.exports = { printDriveRoutes, sniffType, safeName, mayMove, printersOf };
