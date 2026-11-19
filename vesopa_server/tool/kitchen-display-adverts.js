/**
 * Put The Vesopa Kitchen's food adverts on its customer displays (owner,
 * 2026-11-19: "real promotion banners with food and everything for the
 * venue, the Vesopa Kitchen") -- through the back office's own upload route,
 * exactly as a manager would on Devices > Customer display adverts.
 *
 *     node tool/kitchen-display-adverts.js            add them (safe to run again)
 *     node tool/kitchen-display-adverts.js --remove   take away exactly those
 *
 * The banners are tool/kitchen-adverts/*.jpg (tool/make_kitchen_adverts.py:
 * real food photographs, Unsplash licence). The test venue only
 * (manager@vesopa.co.uk); what it adds is written to tmp/kitchen-adverts.json
 * by id, so a second run adds nothing twice and --remove deletes only those.
 * No secret is printed; the session is minted here from the server's config.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const OFFICE = 'manager@vesopa.co.uk';
const BASE = process.env.VERIFY_BASE || 'https://backoffice.vesopaepos.com';
const DIR = path.join(__dirname, 'kitchen-adverts');
const STATE = path.join(__dirname, '..', 'tmp', 'kitchen-adverts.json');
const SECONDS = 8;

async function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set in the environment.');
  const db = mysql.createPool({
    connectionLimit: 1,
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASS || process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
  });
  const [[office]] = await db.query('SELECT id FROM offices WHERE contact_email = ?', [OFFICE]);
  await db.end();
  if (!office) throw new Error('The test venue is not on this server.');
  const token = jwt.sign({ email: OFFICE, officeId: office.id, role: 'office' }, secret, { expiresIn: '15m' });
  const auth = { Authorization: 'Bearer ' + token };

  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { adverts: {} };
  const save = () => {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  };

  if (process.argv.includes('--remove')) {
    let n = 0;
    for (const id of Object.values(state.adverts)) {
      const r = await fetch(`${BASE}/api/display-adverts/${id}`, { method: 'DELETE', headers: auth });
      if (r.ok || r.status === 404) n += 1;
    }
    fs.rmSync(STATE, { force: true });
    console.log(`removed ${n} adverts`);
    return;
  }

  // What the venue has now, so an advert deleted by hand is added again.
  const listed = await fetch(`${BASE}/api/display-adverts`, { headers: auth });
  if (!listed.ok) throw new Error(`GET /api/display-adverts answered ${listed.status}`);
  const body = await listed.json();
  const there = new Set((body.adverts || body || []).map((a) => a.id));

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jpg')).sort();
  let added = 0;
  for (const f of files) {
    if (state.adverts[f] && there.has(state.adverts[f])) {
      console.log(`  = ${f} already on the displays`);
      continue;
    }
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(path.join(DIR, f))], { type: 'image/jpeg' }), f);
    form.append('title', f.replace(/^\d+-/, '').replace(/\.jpg$/, '').replace(/-/g, ' '));
    form.append('seconds', String(SECONDS));
    const r = await fetch(`${BASE}/api/display-adverts`, { method: 'POST', headers: auth, body: form });
    const text = await r.text();
    if (!r.ok) throw new Error(`POST ${f} answered ${r.status}: ${text.slice(0, 200)}`);
    state.adverts[f] = JSON.parse(text).id;
    save();
    added += 1;
    console.log(`  + ${f}`);
  }
  console.log(`The Vesopa Kitchen: ${added} adverts added, ${files.length} in all. Go displays pick them up within 10 minutes, or at once with Reload adverts on the phone's remote.`);
}

main().catch((e) => {
  console.error(`kitchen-display-adverts: ${String(e.message || e).slice(0, 300)}`);
  process.exit(1);
});
