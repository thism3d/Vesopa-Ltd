/** Drive the card designer the way a manager would, and check it responds. */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const BASE = 'https://backoffice.vesopaepos.com';
const OUT = process.env.SHOT_DIR || '.';

function settings() {
  let root = process.cwd();
  for (let i = 0; i < 8; i++) {
    const c = path.join(root, '.env.claude-tools');
    if (fs.existsSync(c)) {
      const v = {};
      for (const line of fs.readFileSync(c, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('=')) continue;
        const at = t.indexOf('=');
        v[t.slice(0, at).trim()] = t.slice(at + 1).trim().replace(/^["']|["']$/g, '');
      }
      return v;
    }
    root = path.dirname(root);
  }
  throw new Error('.env.claude-tools not found');
}
const CFG = settings();

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message));
    await page.setViewport({ width: 1600, height: 1000 });
    await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.type('#email', CFG.VESOPA_TEST_EMAIL, { delay: 5 });
    await page.type('#password', CFG.VESOPA_TEST_PASSWORD, { delay: 5 });
    await Promise.all([
      page.click('#login-form button[type="submit"]'),
      page.waitForFunction(() => !!document.querySelector('nav .nav'), { timeout: 30000 }),
    ]);
    await new Promise((r) => setTimeout(r, 2000));

    await page.evaluate(() => {
      const b = document.querySelector('.nav[data-view="dinein_qr"]');
      const h = [...document.querySelectorAll('.nav-group')].find((x) => x.dataset.group === 'dinein');
      if (h && h.classList.contains('collapsed')) h.click();
      if (b) b.click();
    });
    await page.waitForSelector('#dc-page', { timeout: 20000 });
    // Scroll the canvas into the viewport before touching it. Without this the
    // card sits at y=1654 in a 1000px window and every click lands on nothing —
    // which looks exactly like a broken editor and is a broken test.
    await page.evaluate(() =>
      document.getElementById('dc-page')
        .scrollIntoView({ behavior: 'instant', block: 'center' })
    );
    await new Promise((r) => setTimeout(r, 1500));

    console.log('\nThe card designer\n');

    check('the canvas drew the card', await page.$eval('#dc-page', (e) => e.children.length > 0));
    check('the code is a real QR, not a placeholder',
      await page.$eval('.dc-qr', (e) => !!e.querySelector('svg')));

    // ---- selecting -------------------------------------------------------
    const scrollBack = async () => {
      await page.evaluate(() => {
        const el = document.getElementById('dc-page');
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
      });
      await new Promise((r) => setTimeout(r, 250));
    };
    const first = await page.$('[data-el-index="1"]');
    const box = await first.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await scrollBack();
    await new Promise((r) => setTimeout(r, 400));
    check('clicking an element selects it',
      await page.$eval('.dc-el.is-selected', (e) => !!e).catch(() => false));
    check('and the panel switches to that element',
      (await page.$eval('#dc-panel h4', (e) => e.textContent)) !== 'The card');

    // ---- dragging --------------------------------------------------------
    const before = await page.evaluate(() => ({ ...diDesign.elements[1] }));
    await scrollBack();
    const b2 = await (await page.$('[data-el-index="1"]')).boundingBox();
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.mouse.down();
    await page.mouse.move(b2.x + b2.width / 2 + 60, b2.y + b2.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 500));
    const after = await page.evaluate(() => ({ ...diDesign.elements[1] }));
    check('dragging moves it', after.x > before.x + 2 && after.y > before.y + 2,
      `x ${before.x.toFixed(1)}→${after.x.toFixed(1)}, y ${before.y.toFixed(1)}→${after.y.toFixed(1)}`);

    // ---- undo ------------------------------------------------------------
    await page.click('#dc-undo');
    await new Promise((r) => setTimeout(r, 400));
    const undone = await page.evaluate(() => ({ ...diDesign.elements[1] }));
    check('undo puts it back',
      Math.abs(undone.x - before.x) < 0.01 && Math.abs(undone.y - before.y) < 0.01,
      `x ${undone.x.toFixed(1)} vs ${before.x.toFixed(1)}`);

    // ---- resizing --------------------------------------------------------
    await scrollBack();
    const b3 = await (await page.$('[data-el-index="1"]')).boundingBox();
    await page.mouse.click(b3.x + b3.width / 2, b3.y + b3.height / 2);
    await new Promise((r) => setTimeout(r, 400));
    const handle = await page.$('.dc-handle');
    if (handle) {
      const hb = await handle.boundingBox();
      const wBefore = await page.evaluate(() => diDesign.elements[1].w);
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb.x + 50, hb.y + 30, { steps: 6 });
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 400));
      const wAfter = await page.evaluate(() => diDesign.elements[1].w);
      check('the corner handle resizes it', wAfter > wBefore + 1,
        `w ${wBefore.toFixed(1)}→${wAfter.toFixed(1)}`);
      check('and the code stays square so it still scans',
        await page.evaluate(() => {
          const qr = diDesign.elements.find((e) => e.kind === 'qr');
          if (!qr) return true;
          const [w, h] = [148, 210];
          return Math.abs(qr.h - (qr.w * w) / h) < 2;
        }));
    } else {
      check('the corner handle exists', false);
    }

    // ---- themes ----------------------------------------------------------
    await page.evaluate(() => { dcSelected = -1; dcRender(); });
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => document.querySelector('[data-theme="banner"]').click());
    await new Promise((r) => setTimeout(r, 600));
    check('a theme replaces the card',
      await page.evaluate(() => diDesign.elements.some((e) => e.kind === 'box')));

    // ---- adding and deleting --------------------------------------------
    const count = await page.evaluate(() => diDesign.elements.length);
    await page.evaluate(() => document.querySelector('[data-add-kind="text"]').click());
    await new Promise((r) => setTimeout(r, 400));
    check('adding puts a new element on',
      (await page.evaluate(() => diDesign.elements.length)) === count + 1);
    await page.click('#dc-delete');
    await new Promise((r) => setTimeout(r, 400));
    check('deleting takes it off',
      (await page.evaluate(() => diDesign.elements.length)) === count);

    await page.screenshot({ path: path.join(OUT, 'bo-card-banner.png') });

    // Put the card back as it was, so this test does not leave the venue with
    // a theme it did not choose.
    await page.evaluate(() => {
      document.querySelector('[data-theme="clean"]').click();
    });
    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate(() => document.getElementById('di-design-save').click());
    await new Promise((r) => setTimeout(r, 1200));
    console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
    if (fail) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
