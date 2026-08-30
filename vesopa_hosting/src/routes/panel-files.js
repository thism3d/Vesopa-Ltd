/**
 * The file manager's HTTP surface.
 *
 * Mounted at /panel/files, inside the panel router, so it inherits the
 * signed-in guard there. Every handler still calls `files.accountFor()` rather
 * than trusting that guard on its own — the guard proves there is a session,
 * and this proves the session belongs to somebody with hosting to look at.
 *
 * THE ROUTES NEVER SEE A UNIX PATH. A customer sends `web/site.com/public_html`
 * and it means "inside my home". Which home that is comes from the session, is
 * added by src/files.js, and is re-checked by the broker. Nothing a browser
 * sends can name an account.
 *
 * BODIES ARE NOT JSON, FOR TWO ROUTES, DELIBERATELY:
 *
 *   write    the editor can save up to 2 MB and server.js parses JSON at a
 *            512 KB limit — a global that exists for good reasons and should
 *            not be raised for every request in the app. `text/plain` slips
 *            past the JSON parser entirely and is parsed here at its own limit.
 *   upload   raw bytes, streamed straight through to the broker. Parsing a
 *            400 MB multipart body into memory to write it back out again is
 *            the thing this avoids.
 */

const express = require('express');

const auth = require('../auth');
const db = require('../db');
const files = require('../files');
const hestia = require('../integrations/hestia');
const { SITE_URL } = require('../config');

const router = express.Router();

/** Where a customer lands, and what "home" means in the breadcrumb. */
const DEFAULT_PATH = 'web';

/**
 * Every mutating route checks this.
 *
 * The token arrives in `X-CSRF-Token` because these are fetch() calls with no
 * form body — `auth.checkCsrf` already reads that header, so nothing new is
 * needed on the auth side. SameSite=lax on the session cookie is the other
 * half; this is the belt to it.
 */
function guard(req, res, next) {
  if (!auth.checkCsrf(req)) {
    return res.status(403).json({ ok: false, error: 'Your session expired. Reload the page and try again.' });
  }
  next();
}

/**
 * Turn whatever went wrong into one JSON shape.
 *
 * A FileError carries a status and a sentence written for a customer. Anything
 * else is a bug here, and says so without leaking a stack trace to the browser.
 */
function sendError(res, err, where) {
  if (err instanceof files.FileError) {
    return res.status(err.status).json({ ok: false, error: err.message, code: err.code });
  }
  console.error(`[files] ${where} failed:`, err.stack || err.message);
  return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
}

/** The account, or a thrown FileError. Every route starts with this. */
const who = (req) => files.accountFor(req.customer);

/** `paths` from a JSON body, defensively — it drives destructive operations. */
function pathList(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((p) => typeof p === 'string' && p.length && p.length < 4096).slice(0, 2000);
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const username = await who(req);

    /*
     * The shortcut row across the top is built from what is actually on disk
     * under ~/web, not from the `services` and `domains` tables. A domain that
     * was added an hour ago and a domain that was removed last week both show
     * the truth this way, and the file manager never disagrees with the folder
     * the customer is looking at.
     */
    let sites = [];
    try {
      const listing = await files.call(username, { op: 'list', path: 'web' });
      sites = (listing.entries || [])
        .filter((e) => e.type === 'dir')
        .map((e) => e.name)
        .sort();
    } catch {
      /* No ~/web yet, or the broker is down. The page says so on its own. */
    }

    /*
     * Disk usage, in the one place somebody is about to spend it.
     *
     * A file manager without a quota read-out is a file manager that lets you
     * upload happily until the node refuses a write, and the error a customer
     * gets at that point is whatever their FTP client or PHP script chose to
     * say. Showing it here turns "why did my upload fail" into something they
     * can see coming.
     *
     * Off the node, and never fatal: the file manager's job is files, and a
     * usage figure that could not be fetched must not take the page down.
     */
    let disk = null;
    try {
      const stats = await hestia.userStats(username);
      if (stats && stats.disk_quota_mb) {
        disk = {
          usedMb: Number(stats.disk_used_mb || 0),
          quotaMb: Number(stats.disk_quota_mb),
          pct: Math.min(100, Math.round((stats.disk_used_mb / stats.disk_quota_mb) * 100)),
        };
      } else if (stats) {
        disk = { usedMb: Number(stats.disk_used_mb || 0), quotaMb: 0, pct: 0 };
      }
    } catch {
      disk = null;
    }

    res.render('panel/files', {
      title: 'Files',
      robots: 'noindex',
      username,
      sites,
      disk,
      startPath: typeof req.query.path === 'string' ? req.query.path : DEFAULT_PATH,
      maxEdit: files.MAX_EDIT,
      maxUpload: files.MAX_UPLOAD,
      hostLabel: new URL(SITE_URL).hostname,
    });
  } catch (err) {
    if (err instanceof files.FileError && err.code === 'nohosting') {
      const { flash } = require('../http-utils');
      flash(res, 'There is no active hosting on this account yet, so there are no files to manage.', 'warn');
      return res.redirect('/panel');
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
router.get('/api/list', async (req, res) => {
  try {
    const username = await who(req);
    const out = await files.call(username, {
      op: 'list',
      path: String(req.query.path || ''),
      hidden: req.query.hidden === '1',
    });
    res.json(out);
  } catch (err) {
    sendError(res, err, 'list');
  }
});

router.get('/api/search', async (req, res) => {
  try {
    const username = await who(req);
    const out = await files.call(username, {
      op: 'search',
      path: String(req.query.path || ''),
      query: String(req.query.q || ''),
    });
    res.json(out);
  } catch (err) {
    sendError(res, err, 'search');
  }
});

/** File contents for the editor. Text only — the broker refuses anything with a NUL in it. */
router.get('/api/read', async (req, res) => {
  try {
    const username = await who(req);
    const { header, socket } = await files.openStream(username, {
      op: 'read',
      path: String(req.query.path || ''),
    });
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => {
      res.type('text/plain; charset=utf-8').send(Buffer.concat(chunks));
    });
    socket.on('error', () => res.status(502).json({ ok: false, error: 'The file could not be read.' }));
  } catch (err) {
    sendError(res, err, 'read');
  }
});

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/** Quote a filename for Content-Disposition without letting it break the header. */
function disposition(name, inline) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; `
    + `filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * One file.
 *
 * A GET so it can be a plain link, which is what makes it work on a phone: a
 * fetch() into a Blob would hold the whole file in the browser's memory before
 * the customer sees a save dialog.
 *
 * `?inline=1` is used by the image preview. It is safe only because of the
 * Content-Type below: a customer's own HTML served inline from this origin
 * would be a stored XSS against the panel, so everything is sent as an opaque
 * download type and the preview is limited to images by the client.
 */
router.get('/download', async (req, res) => {
  try {
    const username = await who(req);
    const wanted = String(req.query.path || '');
    const { header, socket } = await files.openStream(username, { op: 'download', path: wanted });

    const name = header.name || 'download';
    const inline = req.query.inline === '1' && /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(name);

    /*
     * NEVER serve a customer's file as its own type on this origin.
     *
     * cloud.vesopa.com holds the session cookie for every customer. A file
     * called `x.html` served as text/html here would run as this origin, read
     * that cookie and act as the customer who opened it — a stored XSS with a
     * file upload as the delivery mechanism. Images are the one exception,
     * because the preview needs them and an image cannot execute; even those
     * get nosniff and a sandboxed CSP.
     */
    if (inline) {
      const ext = name.toLowerCase().split('.').pop();
      res.type(ext === 'jpg' ? 'jpeg' : ext);
    } else {
      res.type('application/octet-stream');
    }
    res.setHeader('Content-Disposition', disposition(name, inline));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (typeof header.size === 'number' && header.size >= 0) {
      res.setHeader('Content-Length', String(header.size));
    }

    socket.pipe(res);
    // A customer who cancels a download leaves us piping into a dead response.
    res.on('close', () => socket.destroy());
    socket.on('error', () => res.destroy());
  } catch (err) {
    if (err instanceof files.FileError) return res.status(err.status).send(err.message);
    console.error('[files] download failed:', err.stack || err.message);
    res.status(500).send('That file could not be downloaded.');
  }
});

/**
 * A selection, as a zip.
 *
 * A POST from a real form rather than fetch(), for the same reason as above:
 * the browser streams it to disk. A form also carries the CSRF token the way
 * every other form in this app does.
 *
 * There is no Content-Length — the zip is generated as it is sent, so its size
 * is not known when the headers go out. Chunked encoding handles it, and the
 * only cost is that the browser cannot show a progress bar.
 */
router.post('/zip', async (req, res) => {
  if (!auth.checkCsrf(req)) return res.status(403).send('Your session expired. Reload the page and try again.');
  try {
    const username = await who(req);
    const paths = pathList(req.body.paths);
    if (!paths.length) return res.status(400).send('Nothing was selected.');

    const name = String(req.body.name || 'files.zip').replace(/[\/\\\x00]/g, '_').slice(0, 200);
    const { header, socket } = await files.openStream(username, { op: 'zipstream', paths, name });

    res.type('application/zip');
    res.setHeader('Content-Disposition', disposition(header.name || name, false));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    socket.pipe(res);
    res.on('close', () => socket.destroy());
    socket.on('error', () => res.destroy());
  } catch (err) {
    if (err instanceof files.FileError) return res.status(err.status).send(err.message);
    console.error('[files] zip failed:', err.stack || err.message);
    res.status(500).send('That download could not be built.');
  }
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Save from the editor.
 *
 * text/plain, so server.js's 512 KB JSON limit does not apply — see the note at
 * the top of this file. The path is in the query string because the body is the
 * file.
 */
router.post(
  '/api/write',
  express.text({ limit: '4mb', type: ['text/plain', 'text/*'] }),
  guard,
  async (req, res) => {
    try {
      const username = await who(req);
      const out = await files.callWithBody(
        username,
        { op: 'write', path: String(req.query.path || '') },
        typeof req.body === 'string' ? req.body : '',
      );
      res.json(out);
    } catch (err) {
      sendError(res, err, 'write');
    }
  },
);

/**
 * One uploaded file, raw.
 *
 * PUT with the bytes as the whole body: no multipart parser, no dependency, and
 * the stream goes to the broker as it arrives. One request per file, which also
 * means per-file progress and per-file failure rather than one all-or-nothing
 * batch.
 *
 * A raw PUT with a custom header is not a "simple request", so a cross-origin
 * page cannot make one without a preflight that this app never answers. The
 * CSRF check is still here, because defence that depends on a browser getting
 * CORS right is defence with one leg.
 */
router.put('/api/upload', guard, async (req, res) => {
  try {
    const username = await who(req);
    const length = Number(req.get('Content-Length'));
    const out = await files.callWithStream(
      username,
      {
        op: 'upload',
        path: String(req.query.path || ''),
        name: String(req.query.name || ''),
        overwrite: req.query.overwrite === '1',
      },
      req,
      length,
    );
    res.json(out);
  } catch (err) {
    // The request body may still be arriving. Draining it keeps the connection
    // reusable and stops the browser reporting a network error instead of the
    // message that explains what actually happened.
    req.resume();
    sendError(res, err, 'upload');
  }
});

// ---------------------------------------------------------------------------
// Everything else: small JSON in, small JSON out
// ---------------------------------------------------------------------------

/**
 * The plain operations, declared as a table rather than as fifteen near
 * identical route handlers. Each entry maps the request body onto the broker's
 * arguments, and nothing else varies.
 */
const SIMPLE = {
  mkdir: (b) => ({ op: 'mkdir', path: b.path, name: b.name }),
  touch: (b) => ({ op: 'touch', path: b.path, name: b.name }),
  rename: (b) => ({ op: 'rename', path: b.path, name: b.name }),
  move: (b) => ({ op: 'move', paths: pathList(b.paths), dest: b.dest }),
  copy: (b) => ({ op: 'copy', paths: pathList(b.paths), dest: b.dest }),
  delete: (b) => ({ op: 'delete', paths: pathList(b.paths) }),
  chmod: (b) => ({
    op: 'chmod', paths: pathList(b.paths), mode: b.mode, recursive: !!b.recursive,
  }),
  compress: (b) => ({
    op: 'compress', paths: pathList(b.paths), dest: b.dest, name: b.name,
  }),
  extract: (b) => ({ op: 'extract', path: b.path, dest: b.dest }),
};

/** Which operations are worth a line in the activity log. */
const LOGGED = new Set(['delete', 'chmod', 'extract', 'move']);

Object.entries(SIMPLE).forEach(([name, build]) => {
  router.post(`/api/${name}`, guard, async (req, res) => {
    try {
      const username = await who(req);
      const out = await files.call(username, build(req.body || {}));

      if (LOGGED.has(name)) {
        const body = req.body || {};
        db.logActivity({
          actorType: 'customer',
          actorId: req.customer.id,
          action: `files.${name}`,
          target: `${username}:${(pathList(body.paths)[0] || body.path || '')}`.slice(0, 190),
          ip: req.ip,
        }).catch(() => {});
      }
      res.json(out);
    } catch (err) {
      sendError(res, err, name);
    }
  });
});

module.exports = router;
