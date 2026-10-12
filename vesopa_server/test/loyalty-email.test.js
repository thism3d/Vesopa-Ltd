// The sign-in code email: Gmail drops a style attribute that a double quote
// cuts short, which took the padding off and hid the venue's name.
const { test } = require('node:test');
const assert = require('node:assert');
const email = require('../src/loyalty_email');
const { venueAccount } = require('../src/mailer');

const brand = { name: 'Pontardawe RFC', colours: { primary: '#000000' }, icon: 'https://example.test/crest.png' };

test('no style attribute is cut short by a double quote', () => {
  const { html } = email.signInCode(brand, { code: '506757', minutes: 10 });
  for (const m of html.matchAll(/style="([^"]*)"(.)/g)) {
    assert.match(m[2], /[\s>/]/, `style ends early: ${m[1].slice(0, 60)}`);
  }
  assert.ok(!/font:\s*\d/.test(html), 'font shorthand left in');
});

test('the venue name is drawn in light ink on a dark header', () => {
  const { html } = email.signInCode(brand, { code: '506757', minutes: 10 });
  assert.match(html, /color:#ffffff;">Pontardawe RFC</);
  assert.match(html, /506757/);
});

test('a venue mailbox is used when the server has one', () => {
  delete process.env.LOYALTY_PONTARDAWE_RFC_SMTP_USER;
  delete process.env.MENU_SMTP_USER;
  assert.strictEqual(venueAccount('pontardawe-rfc'), undefined);
  process.env.MENU_SMTP_USER = 'menu@example.test';
  assert.strictEqual(venueAccount('pontardawe-rfc'), 'menu');
  process.env.LOYALTY_PONTARDAWE_RFC_SMTP_USER = 'info@pontardawerfc.com';
  process.env.LOYALTY_PONTARDAWE_RFC_SMTP_PASSWORD = 'x';
  assert.strictEqual(venueAccount('pontardawe-rfc'), 'LOYALTY_PONTARDAWE_RFC');
  delete process.env.LOYALTY_PONTARDAWE_RFC_SMTP_USER;
  delete process.env.LOYALTY_PONTARDAWE_RFC_SMTP_PASSWORD;
  delete process.env.MENU_SMTP_USER;
});
