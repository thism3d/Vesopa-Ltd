/**
 * Vesopa AI in a real browser: the back office's own page and the real
 * /api/ai routes, on the in-memory venue (test/lib/ai_fake_venue.js), so the
 * layout can be checked on a desktop and a phone, in Day and Night, without a
 * database. The figures are the fake venue's, never a customer's.
 *
 *   node test/ai-advisor-browser.js [outDir]
 *
 * Writes screenshots to outDir (default: the system temp folder) and fails if
 * the page logs an error or an answer has no period, site or records.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

delete process.env.DEEPSEEK_API_KEY;
const { issueToken } = require('../src/auth');
const { aiRoutes } = require('../src/ai_advisor');
const { pool, SECRET } = require('./lib/ai_fake_venue');

const PUBLIC = path.join(__dirname, '..', 'public');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'vesopa-ai-shots');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const token = issueToken({ id: 1, email: 'owner@example.com', name: 'Meirion Owner', role: 'office', officeId: 1 }, SECRET);
  const app = express();
  app.get('/e2e-boot', (req, res) => {
    const theme = req.query.theme === 'dark' ? 'dark' : 'light';
    res.type('html').send(`<!doctype html><meta charset="utf-8"><script>
      localStorage.setItem('vesopa_token', ${JSON.stringify(token)});
      localStorage.setItem('vesopa.theme', '${theme}');
      localStorage.setItem('vesopa_user', JSON.stringify({ id: 1, name: 'Meirion Owner', role: 'office', officeId: 1, officeName: 'Vesopa Kitchen', email: 'owner@example.com', officeEmail: 'kitchen@example.com' }));
      location.replace('/vesopa-ai');
    </script>`);
  });
  app.use(aiRoutes({ pool, secret: SECRET, mailer: async () => true }));
  app.all(/^\/api\//, (req, res) => res.json(req.method === 'GET' ? (/me\/access/.test(req.path) ? { unrestricted: true, permissions: [] } : /modules/.test(req.path) ? [] : {}) : { ok: true }));
  app.use(express.static(PUBLIC));
  app.get(/^\/(?!api)/, (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const { launch, sleep } = require('./lib/chrome');
  const errors = [];
  const shot = async (cdp, name, full) => {
    let clip;
    if (full) {
      const size = await cdp.eval('return { w: document.documentElement.scrollWidth, h: Math.min(document.documentElement.scrollHeight, 6000) };');
      clip = { x: 0, y: 0, width: size.w, height: size.h, scale: 1 };
    }
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full, ...(clip ? { clip } : {}) });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  };
  try {
    for (const [label, width, height, mobile, theme] of [
      ['desktop-day', 1440, 1000, false, 'light'],
      ['desktop-night', 1440, 1000, false, 'dark'],
      ['phone-day', 390, 844, true, 'light'],
      ['phone-night', 390, 844, true, 'dark'],
    ]) {
      const b = await launch(`${base}/e2e-boot?theme=${theme}`, { width, height });
      if (!b) { console.log('SKIPPED: no Chromium'); return; }
      const { cdp } = b;
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
        cdp.on && cdp.on('Runtime.exceptionThrown', (e) => errors.push(`${label}: ${JSON.stringify(e.exceptionDetails && e.exceptionDetails.text)}`));
        if (!(await cdp.until("return !!document.querySelector('.vai-hero');", { tries: 100 }))) {
          const state = await cdp.eval("return { path: location.pathname, view: typeof currentView !== 'undefined' ? currentView : null, body: (document.getElementById('vai-body') || {}).innerHTML, login: !!document.querySelector('#login:not([hidden]), .login:not([hidden])' ) , txt: document.body.innerText.slice(0, 400) };");
          throw new Error(`${label}: the briefing never drew ${JSON.stringify(state)}`);
        }
        await cdp.eval(`document.documentElement.setAttribute('data-theme', '${theme === 'dark' ? 'dark' : 'light'}');`);
        await sleep(300);
        await shot(cdp, `${label}-1-briefing`, true);

        await cdp.eval("vaiSend('Why did sales drop today?');");
        if (!(await cdp.until("return document.querySelector('.vai-a .vai-meta summary') && !document.querySelector('.vai-typing');", { tries: 100 }))) throw new Error(`${label}: no answer`);
        const meta = await cdp.eval("return document.querySelector('.vai-a .vai-meta summary').textContent;");
        if (!/Today/.test(meta)) errors.push(`${label}: answer has no period: ${meta}`);
        await cdp.eval("document.querySelector('.vai-a .vai-meta').open = true; window.scrollTo(0, 0);");
        await sleep(300);
        await shot(cdp, `${label}-2-ask`, true);

        await cdp.eval("document.querySelector('.vai-a [data-record]').click();");
        if (!(await cdp.until("return document.querySelectorAll('.vai-modal table tbody tr').length;", { tries: 60 }))) errors.push(`${label}: records never loaded`);
        await shot(cdp, `${label}-3-records`, false);
        await cdp.eval("document.querySelector('.vai-modal [data-close]').click();");

        for (const tab of ['stock', 'profit', 'team']) {
          await cdp.eval(`document.querySelector('#vai-tabs [data-tab="${tab}"]').click();`);
          await cdp.until("return document.querySelector('.vai-section') && !document.querySelector('.vai-section .vai-loading');", { tries: 100 });
          await sleep(200);
          await shot(cdp, `${label}-4-${tab}`, true);
        }
        if (label === 'desktop-day') {
          await cdp.eval("document.querySelector('#vai-invite').click();");
          await cdp.until("return !!document.querySelector('#vai-inv-form');");
          await sleep(300);
          await shot(cdp, `${label}-5-invite`, false);
        }
        const overflow = await cdp.eval('return document.documentElement.scrollWidth > window.innerWidth + 1;');
        if (overflow) errors.push(`${label}: the page scrolls sideways`);
      } finally {
        await b.close();
      }
    }
  } finally {
    server.close();
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`Vesopa AI browser check passed. Screenshots in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
