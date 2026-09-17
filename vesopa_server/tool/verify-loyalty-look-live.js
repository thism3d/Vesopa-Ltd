/**
 * The loyalty app's member routes after the 2026-09-15 changes, on live.
 *
 *   cd @app && node tool/verify-loyalty-look-live.js
 *
 * Runs ON the server. Mints a member session for one member of the test
 * venue (manager@vesopa.co.uk) exactly as sign-in would -- a row in
 * epos_loyalty_app_sessions and a token signed with JWT_SECRET -- so nobody's
 * password is typed anywhere and no code is emailed. Checks the branding
 * carries the new settings, /me carries the membership block, the inbox
 * honours the venue's limit, and a photo goes on and comes off. Puts back
 * the venue's inbox limit and the member's photo, and revokes the session.
 */

require('dotenv').config();

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const OFFICE = 'manager@vesopa.co.uk';
const SLUG = 'thevesopakitchen';
const BASE = process.env.VERIFY_BASE || 'https://loyalty.vesopa.com';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

// A 1x1 PNG, so the upload is a real image and nothing else.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

async function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set.');
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASS || process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
  });

  const [[member]] = await db.query(
    "SELECT id, name, photo_url FROM epos_customers WHERE email_key = ? AND email IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    [OFFICE]
  );
  assert(member, 'the test venue has no member');
  const [[app]] = await db.query('SELECT inbox_mode, inbox_limit FROM epos_loyalty_app WHERE office = ?', [OFFICE]);
  const jti = crypto.randomUUID();
  await db.execute(
    `INSERT INTO epos_loyalty_app_sessions (id, office, customer_id, platform, created_at, last_seen_at)
     VALUES (?, ?, ?, 'verify', NOW(), NOW())`,
    [jti, OFFICE, member.id]
  );
  const token = jwt.sign({ scope: 'loyalty', office: OFFICE, cid: member.id }, secret, { expiresIn: '10m', jwtid: jti });

  const call = async (path, { method = 'GET', body, form } = {}) => {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  async function restore() {
    await db.execute('UPDATE epos_loyalty_app SET inbox_mode = ?, inbox_limit = ? WHERE office = ?', [app.inbox_mode, app.inbox_limit, OFFICE]);
    await db.execute('UPDATE epos_customers SET photo_url = ? WHERE id = ?', [member.photo_url, member.id]);
    await db.execute('DELETE FROM epos_loyalty_app_sessions WHERE id = ?', [jti]);
  }

  try {
    await check('the branding carries the icon colour, text size and news rules', async () => {
      const res = await fetch(`${BASE}/loyalty/v1/app/${SLUG}`);
      const b = await res.json();
      assert(res.status === 200, `status ${res.status}`);
      assert('icon' in b.colours, 'no colours.icon');
      assert(typeof b.font_scale === 'number', 'no font_scale');
      assert(b.inbox && b.inbox.mode && b.inbox.limit, 'no inbox rules');
    });

    await check('/me carries the membership block and the photo', async () => {
      const r = await call('/loyalty/v1/me');
      assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
      assert(r.body.membership && 'expiry' in r.body.membership && 'fee_minor' in r.body.membership, 'no membership block');
      assert('photo_url' in r.body, 'no photo_url');
    });

    await check('the inbox honours a limit of one, and says so', async () => {
      await db.execute("UPDATE epos_loyalty_app SET inbox_mode = 'limit', inbox_limit = 1 WHERE office = ?", [OFFICE]);
      const r = await call('/loyalty/v1/me/messages');
      assert(r.status === 200, `status ${r.status}`);
      assert(r.body.mode === 'limit' && r.body.limit === 1, `rules ${JSON.stringify(r.body)}`);
      assert(r.body.items.length <= 1, `${r.body.items.length} items`);
      assert(r.body.more === false, 'a limited inbox has no more');
    });

    await check('the inbox pages when the venue keeps everything', async () => {
      await db.execute("UPDATE epos_loyalty_app SET inbox_mode = 'scroll' WHERE office = ?", [OFFICE]);
      const r = await call('/loyalty/v1/me/messages?limit=1');
      assert(r.status === 200 && r.body.mode === 'scroll', `status ${r.status}`);
      if (r.body.more) {
        const next = await call(`/loyalty/v1/me/messages?limit=1&before=${encodeURIComponent(r.body.items[0].shown_at)}`);
        assert(next.status === 200 && next.body.items.length >= 1, 'no second page');
        assert(next.body.items[0].id !== r.body.items[0].id, 'the second page repeated the first');
      }
    });

    await check('a photo goes on the card and comes off again', async () => {
      const form = new FormData();
      form.append('image', new Blob([PNG], { type: 'image/png' }), 'face.png');
      const up = await call('/loyalty/v1/me/photo', { method: 'POST', form });
      assert(up.status === 201 && up.body.photo_url, `upload ${up.status} ${JSON.stringify(up.body)}`);
      const me = await call('/loyalty/v1/me');
      assert(me.body.photo_url === up.body.photo_url, 'not on /me');
      const served = await fetch(`https://backoffice.vesopaepos.com${up.body.photo_url}`);
      assert(served.status === 200, `the photo is not served: ${served.status}`);
      const off = await call('/loyalty/v1/me/photo', { method: 'DELETE' });
      assert(off.status === 200, `remove ${off.status}`);
      const after = await call('/loyalty/v1/me');
      assert(after.body.photo_url === null, 'still on /me');
    });

    await check('a non-image is refused', async () => {
      const form = new FormData();
      form.append('image', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'x.txt');
      const up = await call('/loyalty/v1/me/photo', { method: 'POST', form });
      assert(up.status === 400, `status ${up.status}`);
    });
  } finally {
    await restore();
    await db.end();
  }
  console.log(`\nverify-loyalty-look-live: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
