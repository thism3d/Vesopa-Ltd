// Invitation links (2026-10-13): the /invite/:token page went missing in a
// rewrite while invitations kept being emailed, so every link answered 404.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('the invitation page is routed', () => {
  const router = require('../src/routes/pages.js');
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  assert.ok(paths.includes('/invite/:token'), 'no GET /invite/:token in src/routes/pages.js');
});

test('the invitation page has its template, and the email points at the route', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'views', 'invite.ejs')));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'invitations.js'), 'utf8');
  assert.match(src, /\$\{config\.issuer\}\/invite\/\$\{token\}/);
});

test('signing in directly accepts an open invitation for a proved address', () => {
  const inv = require('../src/invitations');
  assert.strictEqual(typeof inv.acceptPendingFor, 'function');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'oidc.js'), 'utf8');
  assert.match(src, /acceptPendingFor\(application\.id, userId\)/);
  const invSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'invitations.js'), 'utf8');
  assert.match(invSrc, /ui\.verified_at IS NOT NULL/, 'only a verified address may accept');
});
