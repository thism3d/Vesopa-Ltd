const crypto = require('crypto');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth, requireTerminal } = require('./auth');

const A = require('./wallet_apple');
const G = require('./wallet_google');
const QR = require('./qr');
const P = require('./wallet_apple_push');
const { appleWebServiceRoutes } = require('./wallet_apple_webservice');
const { PAGE_FOR, pageLink } = require('./wallet_pages');

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
 * HOW A CARD CHANGES AFTER IT IS ISSUED
 *
 * A `.pkpass` is still a snapshot, but it is no longer only a snapshot. When
 * APPLE_WALLET_WEB_SERVICE_URL is set, every pass carries the address of the
 * update service in wallet_apple_webservice.js, and iOS registers itself there
 * the moment the card is added. A sale that moves somebody's points then calls
 * wallet_apple_push.js, which wakes the phone, and Wallet comes back here for a
 * freshly built card.
 *
 * Leave that variable blank and none of it happens: no pass carries the URL, no
 * device ever registers, and a card is what it always was — correct when issued
 * and refreshed by scanning again. That is a supported way to run this, not a
 * broken one, which is why the routes below are mounted either way and simply
 * have nobody calling them.
 */
function appleWalletRoutes({ pool, secret, core }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  const config = A.cachedConfig();
  const assetsDir = path.join(__dirname, '..', 'assets', 'wallet');
  // Where a venue's own uploads land. The back office writes them at Apple's
  // exact pixel sizes -- the cropper is the codec -- so artworkFor() reads them
  // straight out of here rather than resizing anything.
  const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');

  const { readBrand, readProgramBrand, loadSubject, shortLink } = core;

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

    // This card's own design, with the venue's branding underneath it. The
    // Apple half read the venue row directly and so never saw a per-kind
    // design at all -- the colours, the name and the band a venue set on one
    // card reached the Google pass and not the .pkpass, which is the shape of
    // bug where two phones at the same counter disagree about what the card
    // looks like. readProgramBrand() returns the venue row with the overrides
    // laid on top, so every field this used before is still here.
    const brand = await readProgramBrand(office, kind);
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

    // Where this card links out to. Signed the same way the QR code is — scope
    // `wallet`, naming this office, kind and subject — so the page can identify
    // the holder without asking them to sign in to anything.
    //
    // A year, matching shortLink(). A card lives in a wallet far longer than any
    // session, and a tile that stops working in a month is worse than no tile.
    const page = PAGE_FOR[kind];
    const link = page
      ? {
          url: pageLink(
            kind,
            jwt.sign(
              { scope: 'wallet', office, kind, sub: String(subjectId) },
              secret,
              { expiresIn: '365d' }
            )
          ),
          type: page.type,
          label: page.label,
        }
      : null;

    const built = A.buildPkpass({
      kind,
      config,
      brand,
      subject,
      assetsDir,
      uploadsDir,
      serial,
      authToken,
      link: link && link.url ? link : null,
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
        // `inline`, not `attachment` — this is the difference between a pass
        // that installs and one that does not.
        //
        // Safari has had a download manager since iOS 13, and `attachment` is
        // what sends a file into it. The pass lands in the Files app, and Files
        // is a dead end for `.pkpass`: there is no Quick Look generator for the
        // type, so tapping it does nothing at all and the customer is left
        // holding a card they cannot add, with no error to explain why. With
        // `inline` Safari hands the bytes straight to Wallet and they get the
        // "Add to Apple Wallet" sheet, which is the whole point.
        //
        // The filename still matters to the few clients that do save it. Named
        // after the kind rather than the customer: a file called
        // `sarah-jones.pkpass` in a shared Downloads folder is a small privacy
        // leak for no benefit.
        'Content-Disposition': `inline; filename="vesopa-${kind}.pkpass"`,
        // Built fresh on every scan and carrying a balance, so it must never
        // sit in a CDN or a phone's HTTP cache.
        'Cache-Control': 'no-store, must-revalidate',
      })
      .send(built.bytes);
  }

  /**
   * The same signing material, plus whether there is anybody to push to.
   *
   * Derived from `config` rather than read again: A.readConfig() shells out to
   * openssl several times to work out which bundle holds the right key, and
   * doing that twice at start-up to learn the same answer would be pure cost.
   */
  const pushConfig = {
    ...config,
    host:
      String(process.env.APPLE_WALLET_APNS_HOST || '').trim() || P.APNS_HOST,
    pushEnabled: Boolean(config.configured && config.webServiceUrl),
  };

  // ---------------------------------------------------------------------------
  // Apple's update service
  // ---------------------------------------------------------------------------

  /**
   * Mounted unconditionally, including when push is switched off.
   *
   * The temptation is to mount it only when APPLE_WALLET_WEB_SERVICE_URL is
   * set, on the grounds that nothing can call it otherwise. But passes are
   * permanent: a card issued while the URL was set carries it forever, and it
   * will keep calling these paths long after somebody blanks the variable to
   * turn the feature off. Answering it properly costs nothing; answering 404
   * would put "the web service returned an invalid pass" in a log nobody is
   * reading, on a phone nobody can see.
   */
  router.use(appleWebServiceRoutes({ pool, config, build }));

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

      // Asked of the signer rather than worked out again here. This screen used
      // to check only whether `loyalty_pass.p12` and its four siblings existed,
      // so a server holding one shared bundle — the arrangement the README
      // recommends and this one uses — signed every pass while the page
      // reported all five certificates missing. See A.signingBundle().
      const certificates = Object.entries(A.P12_FILES).map(([kind, file]) => {
        const bundle = config.configured ? A.signingBundle(kind, config) : null;
        return {
          kind,
          label: G.PASS_TYPES[kind].label,
          pass_type_id: G.PASS_TYPES[kind].appleType,
          // The name of the file that will actually sign this kind, so the row
          // says something true either way: which bundle is signing, or which
          // one is missing.
          file: bundle ? bundle.file : file,
          expected_file: file,
          shared: Boolean(bundle && bundle.shared),
          present: Boolean(bundle),
        };
      });

      // What the update service is actually doing, rather than whether it is
      // switched on. A venue that has turned push updates on and has zero
      // registered devices a week later has a problem — most likely a
      // webServiceURL that was wrong when its cards were issued, which no
      // amount of fixing the variable now will repair for a pass already in
      // somebody's pocket. Nothing else in the system would ever say so.
      const [[devices]] = await pool.query(
        `SELECT COUNT(*) AS registered,
                SUM(last_error IS NOT NULL) AS failing,
                MAX(last_push_at) AS last_push
           FROM epos_wallet_devices WHERE office = ?`,
        [office]
      );

      res.json({
        configured: config.configured,
        problems: config.problems,
        openssl: config.openssl,
        team_id: config.teamId,
        web_service_url: config.webServiceUrl || '',
        push_updates: Boolean(config.webServiceUrl),
        apns_host: pushConfig.host,
        devices_registered: Number(devices.registered) || 0,
        devices_failing: Number(devices.failing) || 0,
        last_push_at: devices.last_push || null,
        apple_enabled: Number(brand.apple_enabled ?? 1) === 1,
        certificates,
      });
    } catch (e) {
      next(e);
    }
  });

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

  /**
   * Push this card's update now, and say what happened to each device.
   *
   * The only way to find out whether push updates work on a deployment. Every
   * other path into wallet_apple_push.js is fire-and-forget by design — a sale
   * must not fail because APNs is unreachable — which means the ordinary
   * failure is invisible. This route is the same code with the result kept, so
   * a manager who has just added a card to their own phone can press a button
   * and be told `BadDeviceToken` rather than watching a card not change.
   *
   * Reports rather than throws, for the same reason: `{ pushed: 0, failed: 1 }`
   * with a reason on the device row is a diagnosis, and a 500 is not.
   */
  router.post('/api/wallet/apple/:kind/:subjectId/push', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const kind = String(req.params.kind);
      const subjectId = String(req.params.subjectId);

      if (!pushConfig.pushEnabled) {
        return res.status(503).json({
          error: config.configured
            ? 'Push updates are off: APPLE_WALLET_WEB_SERVICE_URL is not set, so ' +
              'no pass carries an address to be updated at.'
            : `Apple Wallet is not configured: ${config.problems.join('; ')}`,
        });
      }

      const [[row]] = await pool.query(
        `SELECT apple_serial FROM epos_wallet_passes
          WHERE office = ? AND kind = ? AND subject_id = ?`,
        [office, kind, subjectId]
      );
      if (!row || !row.apple_serial) {
        return res.status(404).json({
          error: 'No Apple pass has been issued for this card yet.',
        });
      }

      const result = await P.notifySerial({
        pool,
        serial: row.apple_serial,
        config: pushConfig,
        host: pushConfig.host,
      });

      const [devices] = await pool.query(
        `SELECT device_id, last_push_at, last_error FROM epos_wallet_devices
          WHERE serial_number = ?`,
        [row.apple_serial]
      );

      res.json({ ...result, devices });
    } catch (e) {
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

/**
 * Whether the request came from something that can open a `.pkpass`.
 *
 * User-Agent sniffing, which is normally a mistake — but the question here is
 * not "which browser" but "does this operating system have Apple Wallet", and
 * there is no feature test for that. Getting it wrong is also cheap in one
 * direction: an Android phone wrongly given a `.pkpass` downloads a file it
 * cannot open, so the check is deliberately narrow and everything it is unsure
 * about goes to Google.
 *
 * A Mac is excluded on purpose. macOS has no Wallet app; a `.pkpass` opens in
 * Preview and does nothing useful, so a desktop Safari gets the Google link and
 * can at least read it.
 *
 * At module scope rather than inside the router because the Google half asks it
 * too: when Google cannot mint, whether to fall back to Apple or to show an
 * honest error depends entirely on what the customer is holding. Two copies of
 * this test would be two answers to that question.
 */
function wantsApple(req) {
  const ua = String(req.headers['user-agent'] || '');
  if (/\b(iPhone|iPad|iPod)\b/i.test(ua)) return true;
  // iPadOS 13+ reports itself as a Mac. The touch-points hint is the usual way
  // to tell the two apart, and it is not available here — so an explicit
  // ?apple=1 is offered instead, which is what the "I have an iPhone" link on
  // the landing page sets.
  return String((req.query || {}).apple || '') === '1';
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

module.exports = { appleWalletRoutes, simplePage, wantsApple };
