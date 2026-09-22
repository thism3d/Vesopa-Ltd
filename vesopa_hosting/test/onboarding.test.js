/**
 * Onboarding fixes of 2026-09-22.
 *
 *     node --test test/onboarding.test.js
 *
 *   - a domain attached to hosting must have a real extension and exist
 *   - a domain-only order is registered, not "set up as hosting"
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { checkRealDomain, realExtension, registrable } = require('../src/domain-reality');

const exists = async () => ['ns1.example.net'];
const nxdomain = async () => { const e = new Error('queryNs ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; };
const timeout = async () => { const e = new Error('queryNs ETIMEOUT'); e.code = 'ETIMEOUT'; throw e; };

// ---- real extensions -------------------------------------------------------

test('real extensions pass: .com, .net, .com.bd, .co.uk, .io, an IDN', () => {
  for (const d of ['example.com', 'example.net', 'muzahid.com.bd', 'shop.co.uk', 'app.io', 'site.xn--54b7fta0cc']) {
    assert.equal(realExtension(d), true, d);
  }
});

test('made-up extensions fail: .comm, .xyz123, .c, no extension', () => {
  for (const d of ['mysite.comm', 'shop.xyz123', 'site.c', 'mysite', 'example.co1']) {
    assert.equal(realExtension(d), false, d);
  }
});

test('a fake extension is refused with a message that names it', async () => {
  const msg = await checkRealDomain('mysite.comm', { lookup: exists });
  assert.match(msg, /“\.comm” is not a real domain extension/);
  assert.match(msg, /\.com, \.net or \.com\.bd/);
});

test('no extension at all asks for one', async () => {
  assert.match(await checkRealDomain('mysite', { lookup: exists }), /Add an extension/);
});

// ---- registered or not -----------------------------------------------------

test('a registered domain is accepted', async () => {
  assert.equal(await checkRealDomain('wintk999.com', { lookup: exists }), null);
});

test('a name that does not exist is refused with "register it instead"', async () => {
  const msg = await checkRealDomain('surely-not-registered-8f3k.com', { lookup: nxdomain });
  assert.match(msg, /does not seem to be registered yet/);
  assert.match(msg, /register it with us instead/);
});

test('a DNS timeout does not block a real customer (fails open)', async () => {
  assert.equal(await checkRealDomain('example.com', { lookup: timeout }), null);
});

test('a subdomain is checked by the domain it belongs to', async () => {
  assert.equal(registrable('shop.example.com'), 'example.com');
  assert.equal(registrable('muzahid.com.bd'), 'muzahid.com.bd');
  assert.equal(registrable('blog.muzahid.com.bd'), 'muzahid.com.bd');
  let asked = '';
  await checkRealDomain('shop.example.com', { lookup: async (h) => { asked = h; return []; } });
  assert.equal(asked, 'example.com');
});

// ---- the setup page says what was bought -----------------------------------

const ejs = require('ejs');
const i18n = require('../src/i18n');
const { icon } = require('../src/icons');

function renderSetup(buys, { state = 'provisioning', locale = 'en' } = {}) {
  const file = path.join(__dirname, '..', 'views', 'panel', 'setup.ejs');
  const tpl = fs.readFileSync(file, 'utf8')
    // head/footer partials need the whole app; the card under test does not.
    .replace(/<%- include\('\.\.\/partials\/head'[^%]*%>/, '')
    .replace(/<%- include\('\.\.\/partials\/footer'[^%]*%>/, '');
  const b = i18n.forLocale(locale);
  return ejs.render(tpl, {
    buys, state, order: { id: 9, reference: 'VHTEST', status: 'active', total_pence: 0 },
    service: buys.hosting ? { plan_name: 'Starter', free_domain_eligible: 0 } : null,
    csrf: 'x', t: b.t, th: b.th, icon, locale, items: [], freeTlds: [], freeMax: '', gateways: [],
    selectedGateway: '', canPayOnline: false, isFree: true, chargeQuote: null, paymentsMode: 'live',
    money: (x) => String(x), currency: { code: 'GBP' },
  }, { filename: file });
}

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('domain only: "Registering <domain>", no hosting words, done means the domain', () => {
  const html = renderSetup({ hosting: false, domains: ['wintk999.com'], email: false, kind: 'domain' });
  const words = text(html);
  assert.match(words, /Registering wintk999\.com/);
  assert.doesNotMatch(words, /hosting/i, 'nothing about hosting anywhere on the page');
  assert.match(html, /data-done-title="wintk999\.com is yours"/);
  assert.match(html, /href="\/panel\/domains"/);
  assert.doesNotMatch(words, /Your domain\b(?! is)/, 'no "Your domain" step on the rail');
  assert.doesNotMatch(html, /href="\/panel\/services"/);
});

test('hosting: the hosting words, the three-step rail and See my hosting', () => {
  const html = renderSetup({ hosting: true, domains: [], email: false, kind: 'hosting' });
  const words = text(html);
  assert.match(words, /Setting up your hosting/);
  assert.match(words, /Your domain/);
  assert.match(html, /data-done-title="Your hosting is ready"/);
  assert.match(html, /href="\/panel\/services"/);
});

test('email only: mailboxes, not hosting', () => {
  const html = renderSetup({ hosting: false, domains: [], email: true, kind: 'email' });
  assert.match(text(html), /Setting up your mailboxes/);
  assert.match(html, /href="\/panel\/mail"/);
  assert.doesNotMatch(text(html), /hosting/i);
});

test('the domain-only page renders in Bangla without error', () => {
  const html = renderSetup({ hosting: false, domains: ['wintk999.com'], email: false, kind: 'domain' }, { locale: 'bn' });
  assert.match(html, /wintk999\.com/);
});
