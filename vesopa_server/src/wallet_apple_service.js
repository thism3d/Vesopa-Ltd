const crypto = require('crypto');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth, requireTerminal } = require('./auth');

const A = require('./wallet_apple');
const G = require('./wallet_google');
const QR = require('./qr');

/**
 * Apple Wallet, beside Google Wallet rather than instead of it.
 *
 * ONE LINK, EITHER PHONE
 *
 * The thing a venue actually wants is one QR code. Printing two — "iPhone here,
 * Android there" — puts a decision in front of a customer at a counter, and a
 * decision at a counter is a customer who does neither.
 *
 * So `/wallet/c/:token` looks at what asked. An iPhone or an iPad is handed a
 * signed `.pkpass` and Wallet opens it; anything else is redirected to the
 * Google save link. The token is the same one the existing `/wallet/s/:token`
 * route uses, so a QR already printed on a receipt keeps working and simply
 * starts serving Apple devices properly.
 *
 * WHY THE PASS IS BUILT ON DEMAND
 *
 * A `.pkpass` is a snapshot: it carries the points balance that was true when
 * it was signed. Building it at the moment somebody scans means a loyalty QR
 * printed in March hands over a card with today's balance on it — and the
 * alternative, a stored file, would need invalidating on every sale.
 *
 * WHAT IS DELIBERATELY NOT HERE YET
 *
 * Push updates. `webServiceURL` is written into the pass when it is configured,
 * and `epos_wallet_devices` is ready for the registrations — but the update
 * endpoints and the APNs client are a separate piece of work with their own
 * certificate. Until then a pass is correct when issued and refreshed by
 * scanning again, which is the honest behaviour and is what the card in a
 * customer's wallet says it is.
 */
function appleWalletRoutes({ pool, secret, core }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  const config = A.readConfig();
  const assetsDir = path.join(__dirname, '..', 'assets', 'wallet');

  const { readBrand, loadSubject, shortLink } = core;

  /**
   * Whether the request came from something that can open a `.pkpass`.
   *
   * User-Agent sniffing, which is normally a mistake — but the question here is
   * not "which browser" but "does this operating system have Apple Wallet",
   * and there is no feature test for that. Getting it wrong is also cheap in
   * one direction: an Android phone wrongly given a `.pkpass` downloads a file
   * it cannot open, so the check is deliberately narrow and everything it is
   * unsure about goes to Google.
   *
   * A Mac is excluded on purpose. macOS has no Wallet app; a `.pkpass` opens in
   * Preview and does nothing useful, so a desktop Safari gets the Google link
   * and can at least read it.
   */
  function wantsApple(req) {
    const ua = String(req.headers['user-agent'] || '');
    if (/\b(iPhone|iPad|iPod)\b/i.test(ua)) return true;
    // iPadOS 13+ reports itself as a Mac. The touch-points hint is the usual
    // way to tell the two apart, and it is not available here — so an explicit
    // ?apple=1 is offered instead, which is what the "I have an iPhone" link on
    // the landing page below sets.
    return String(req.query.apple || '') === '1';
  }

  /**
   * Build one `.pkpass`, and remember the serial it was built with.
   *
   * The serial is stable per (office, kind, subject): reissuing a card to the
   * same customer has to produce the *same* serial, or their phone treats it as
   * a second card and they end up with two. It is generated on the first issue
   * and read back on every one after that.
   */
  async function build(office, kind, subjectId) {
    if (!G.PASS_TYPES[kind]) {
      throw Object.assign(new Error(`Unknown pass kind "${kind}"`), { status: 400 });
    }
    if (!config.configured) {
      throw Object.assign(
        new Error(`Apple Wallet is not configured: ${config.problems.join('; ')}`),
        { status: 503 }
      );
    }

    const brand = await readBrand(office);
    if (!Number(brand.apple_enabled ?? 1)) {
      throw Object.assign(new Error('This venue is not issuing Apple passes.'), {
        status: 404,
      });
    }

    const subject = await loadSubject(office, kind, subjectId);
    if (!subject) {
      throw Object.assign(
        new Error('No such customer, staff member or promotion'),
        { status: 404 }
      );
    }

    const [[row]] = await pool.query(
      `SELECT id, apple_serial, apple_auth_token FROM epos_wallet_passes
        WHERE office = ? AND kind = ? AND subject_id = ?`,
      [office, kind, String(subjectId)]
    );

    const serial = (row && row.apple_serial) || crypto.randomUUID();
    const authToken =
      (row && row.apple_auth_token) || crypto.randomBytes(24).toString('hex');

    const built = A.buildPkpass({
      kind,
      config,
      brand,
      subject,
      assetsDir,
      serial,
      authToken,
    });

    // Recorded whether or not a Google object exists. A venue that only ever
    // issues Apple passes still gets a row here, which is what the back office
    // lists and what the till reads back.
    const id = (row && row.id) || crypto.randomUUID();
    await pool.execute(
      `INSERT INTO epos_wallet_passes
         (id, office, kind, subject_id, object_id, card_number, state,
          apple_serial, apple_auth_token, apple_issued_at)
       VALUES (?, ?, ?, ?, '', ?, 'active', ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         card_number      = VALUES(card_number),
         apple_serial     = VALUES(apple_serial),
         apple_auth_token = VALUES(apple_auth_token),
         apple_issued_at  = VALUES(apple_issued_at)`,
      [
        id,
        office,
        kind,
        String(subjectId),
        String(subject.card_number || ''),
        built.serial,
        built.authToken,
      ]
    );

    return { ...built, subject, brand, id };
  }

  /** Send a built pass as a download. */
  function serve(res, kind, built) {
    res
      .status(200)
      .set({
        'Content-Type': 'application/vnd.apple.pkpass',
        // The filename a phone shows while it downloads. Named after the kind
        // rather than the customer: a file called `sarah-jones.pkpass` in a
        // shared Downloads folder is a small privacy leak for no benefit.
        'Content-Disposition': `attachment; filename="vesopa-${kind}.pkpass"`,
        // Built fresh on every scan and carrying a balance, so it must never
        // sit in a CDN or a phone's HTTP cache.
        'Cache-Control': 'no-store, must-revalidate',
      })
      .send(built.bytes);
  }

  // ---------------------------------------------------------------------------
  // The customer-facing link
  // ---------------------------------------------------------------------------

  /**
   * One QR, either phone.
   *
   * Deliberately the same token shape as `/wallet/s/:token`, so the two are
   * interchangeable and a code printed before this route existed keeps working.
   */
  router.get('/wallet/c/:token', async (req, res) => {
    let claims;
    try {
      claims = jwt.verify(String(req.params.token), secret);
    } catch {
      return res
        .status(400)
        .type('html')
        .send(simplePage('This code has expired', 'Ask a member of staff for a new one.'));
    }
    if (claims.scope !== 'wallet') {
      return res.status(400).type('html').send(simplePage('Not a wallet link', ''));
    }

    if (!wantsApple(req)) {
      // Android, or a desktop browser. Hand it to the Google half, which is the
      // route that already knows how to build and register an object.
      return res.redirect(302, `/wallet/s/${req.params.token}`);
    }

    try {
      const built = await build(claims.office, claims.kind, claims.sub);
      return serve(res, claims.kind, built);
    } catch (e) {
      return res
        .status(e.status === 404 ? 404 : 502)
        .type('html')
        .send(simplePage('That card could not be issued', e.message));
    }
  });

  /** The same thing by its parts, for a link built by hand. */
  router.get('/wallet/apple/:office/:kind/:subjectId.pkpass', async (req, res) => {
    try {
      const built = await build(
        String(req.params.office),
        String(req.params.kind),
        String(req.params.subjectId)
      );
      return serve(res, String(req.params.kind), built);
    } catch (e) {
      return res
        .status(e.status || 502)
        .type('html')
        .send(simplePage('That card could not be issued', e.message));
    }
  });

  // ---------------------------------------------------------------------------
  // The back office. Absolute paths, because this router is mounted once at the
  // root -- the customer-facing links above have to live there, and one router
  // with two mounts would answer every route twice.
  // ---------------------------------------------------------------------------

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
   * Whether Apple passes can be issued from this deployment, and what is
   * missing when they cannot.
   *
   * Every problem is named rather than reduced to a boolean, because the whole
   * failure mode of a `.pkpass` is that a bad one produces no diagnostic
   * anywhere. This screen is the only place the reason is ever visible.
   */
  router.get('/api/wallet/apple/status', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const brand = await readBrand(office);

      const certificates = Object.entries(A.P12_FILES).map(([kind, file]) => ({
        kind,
        label: G.PASS_TYPES[kind].label,
        pass_type_id: G.PASS_TYPES[kind].appleType,
        file,
        present: config.configured && certificatePresent(file),
      }));

      res.json({
        configured: config.configured,
        problems: config.problems,
        openssl: config.openssl,
        team_id: config.teamId,
        web_service_url: config.webServiceUrl || '',
        push_updates: Boolean(config.webServiceUrl),
        apple_enabled: Number(brand.apple_enabled ?? 1) === 1,
        certificates,
      });
    } catch (e) {
      next(e);
    }
  });

  function certificatePresent(file) {
    try {
      return require('fs').existsSync(path.join(config.dir, file));
    } catch {
      return false;
    }
  }

  /**
   * A QR code, as an SVG.
   *
   * The back office is a desktop and the customer's phone is not, so what a
   * manager needs on screen is something to point a camera at. Served rather
   * than drawn in the browser because there is no QR library in this project's
   * front end either, and one implementation checked against the till's beats
   * two that might disagree — see src/qr.js.
   *
   * Behind the session: these encode signed links that hand over somebody's
   * loyalty card.
   */
  router.get('/api/qr.svg', auth, (req, res) => {
    const text = String(req.query.text || '').trim();
    if (!text) return res.status(400).type('text').send('text is required');

    try {
      const size = Math.min(Math.max(Number(req.query.size) || 220, 80), 800);
      res
        .type('image/svg+xml')
        // Deterministic for a given payload, and the payload is already a
        // signed token with its own lifetime, so a long cache is safe and
        // saves redrawing it on every scroll.
        .set('Cache-Control', 'private, max-age=86400')
        .send(
          QR.svg(text, {
            size,
            dark: String(req.query.dark || '#111111'),
            light: String(req.query.light || '#ffffff'),
          })
        );
    } catch (e) {
      res.status(400).type('text').send(e.message);
    }
  });

  /**
   * Issue an Apple pass from the back office, and hand back the links.
   *
   * Returns the scannable short link rather than a file: the back office is on
   * a desktop and the customer's phone is not, so what the manager needs is
   * something to point a camera at.
   */
  router.post('/api/wallet/apple/:kind/:subjectId', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const kind = String(req.params.kind);
      const subjectId = String(req.params.subjectId);

      const built = await build(office, kind, subjectId);
      res.json({
        kind,
        subject_id: subjectId,
        serial: built.serial,
        card_number: built.subject.card_number || '',
        // The universal link — this is what goes in a QR code.
        scan_url: shortLink(office, kind, subjectId).replace('/wallet/s/', '/wallet/c/'),
        download_url:
          `/wallet/apple/${encodeURIComponent(office)}/` +
          `${encodeURIComponent(kind)}/${encodeURIComponent(subjectId)}.pkpass`,
        bytes: built.bytes.length,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message });
      }
      next(e);
    }
  });

  // ---------------------------------------------------------------------------
  // The till
  // ---------------------------------------------------------------------------

  /**
   * Every pass a customer holds, for the till to show them.
   *
   * Authorised with the terminal token, not a query string: this says which
   * cards a named person has, and knowing a venue's contact email must not be
   * enough to ask.
   *
   * The scan links are built fresh on every call rather than stored. They are
   * signed and time-limited, and a link that lived in a row would outlive the
   * reason it was made.
   */
  router.get('/till/wallet/passes', requireTerminal(secret), async (req, res, next) => {
    try {
      const office = req.office;
      const subjectId = String(req.query.subject_id || '').trim();
      const kind = String(req.query.kind || '').trim();

      if (!subjectId) {
        return res.status(400).json({ error: 'subject_id is required' });
      }

      const brand = await readBrand(office);
      const rows = [];

      for (const [k, type] of Object.entries(G.PASS_TYPES)) {
        if (kind && k !== kind) continue;
        // Only the programmes this venue runs. A till offering a gift-card pass
        // for a venue with no gift cards is a button that produces an error.
        if (!Number(brand[`${k}_enabled`] ?? 0)) continue;

        const subject = await loadSubject(office, k, subjectId).catch(() => null);
        if (!subject) continue;

        rows.push({
          kind: k,
          label: type.label,
          apple_type: type.appleType,
          name: subject.name || subject.title || '',
          card_number: subject.card_number || '',
          scan_url: shortLink(office, k, subjectId).replace('/wallet/s/', '/wallet/c/'),
        });
      }

      res.json({
        enabled: Number(brand.enabled) === 1,
        apple_enabled: Number(brand.apple_enabled ?? 1) === 1,
        program_name: brand.program_name || '',
        issuer_name: brand.issuer_name || '',
        passes: rows,
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/** A plain page for the handful of things that can go wrong in a browser. */
function simplePage(title, detail) {
  const esc = (s) =>
    String(s || '').replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;
       background:#111;color:#f2f4f0;
       font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  main{max-width:28rem;padding:2rem;text-align:center}
  h1{font-size:1.4rem;margin:0 0 .75rem}
  p{margin:0;color:#9aa0a6}
</style></head><body><main>
<h1>${esc(title)}</h1><p>${esc(detail)}</p>
</main></body></html>`;
}

module.exports = { appleWalletRoutes, simplePage };
