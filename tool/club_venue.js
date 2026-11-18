/**
 * A club's venue in the Vesopa EPOS back office, made once (owner, 2026-11-18:
 * "create the back-office venue loughor-rfc").
 *
 *   cd <back office folder> && node /path/club_venue.js club.json [--check]
 *
 * Run ON the Cloud box from the back office's own folder, so its .env (the
 * database login) and node_modules (mysql2, bcryptjs, dotenv) are used. Driven
 * by tool/deploy_club_site.py, which uploads this file and the club's
 * content/club.json.
 *
 * ONLY ADDS. Every row is looked for first and an existing one is left exactly
 * as it is, so the club's own changes in the back office always win:
 *
 *   offices                   the venue (name, contact email = club.json email)
 *   backoffice_users          its first login, that email, a random password
 *                             (never printed: "Forgot password" at the back
 *                             office sends a reset to the club's mailbox)
 *   epos_loyalty_app          the members' app at slug venue.json slug, on,
 *                             in the club's colours, at the ground
 *   epos_loyalty_app_methods  emailed code, password, passkey, Continue with Vesopa
 *   dinein_venue              the online menu at the same slug (not published:
 *                             the club publishes it when the menu is ready)
 *   epos_event_settings       ticket sales allowed from the club's website
 *
 * Prints names and ids only: the repository's Actions logs are public.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const here = (m) => require(require.resolve(m, { paths: [process.cwd()] }));
here('dotenv').config({ path: path.join(process.cwd(), '.env') });
const mysql = here('mysql2/promise');
const bcrypt = here('bcryptjs');

const [file, ...flags] = process.argv.slice(2);
const CHECK = flags.includes('--check');
if (!file) {
  console.error('usage: node club_venue.js club.json [--check]');
  process.exit(2);
}
const club = JSON.parse(fs.readFileSync(file, 'utf8'));
const SLUG = String(club.slug || '').trim();
const EMAIL = String(club.email || '').trim().toLowerCase();
if (!/^[a-z0-9-]{3,64}$/.test(SLUG) || !/^[^@\s]+@[^@\s]+$/.test(EMAIL)) {
  console.error('club.json needs slug and email');
  process.exit(2);
}

const ok = (m) => console.log(`  ✓ ${m}`);
const todo = (m) => console.log(`  ${CHECK ? '! would' : '▶'} ${m}`);
const missingTable = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
    charset: 'utf8mb4',
  });
  try {
    // The venue.
    let [[office]] = await db.query('SELECT id, name FROM offices WHERE contact_email = ? ORDER BY id LIMIT 1', [EMAIL]);
    if (office) {
      ok(`office ${office.id} "${office.name}"`);
    } else {
      todo(`create office "${club.name}"`);
      if (!CHECK) {
        const [r] = await db.execute("INSERT INTO offices (name, contact_email, plan, status) VALUES (?, ?, NULL, 'active')", [club.name, EMAIL]);
        office = { id: r.insertId, name: club.name };
        ok(`office ${office.id} created`);
      }
    }

    // Its first login.
    const [[user]] = await db.query('SELECT id FROM backoffice_users WHERE email = ? LIMIT 1', [EMAIL]);
    if (user) ok('back office login exists');
    else {
      todo('create the back office login (random password; reset by email)');
      if (!CHECK && office) {
        const hash = await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 12);
        await db.execute(
          "INSERT INTO backoffice_users (email, password, name, company, approved, role, office_id) VALUES (?, ?, ?, ?, 'Y', 'office', ?)",
          [EMAIL, hash, club.name, club.company ? club.company.name : club.name, office.id]);
        ok('back office login created');
      }
    }

    // The members' app.
    const [[app]] = await db.query('SELECT office, slug, enabled FROM epos_loyalty_app WHERE slug = ? OR office = ? LIMIT 1', [SLUG, EMAIL]);
    if (app) ok(`members' app: slug ${app.slug || '(none)'}, ${app.enabled ? 'on' : 'off'}`);
    else {
      todo(`members' app at slug ${SLUG}`);
      if (!CHECK) {
        const c = club.colours || {};
        const a = club.address || {};
        await db.execute(
          `INSERT INTO epos_loyalty_app (office, enabled, slug, app_name, welcome_text, colour_primary, colour_accent,
             colour_background, colour_text, latitude, longitude)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, '#FFFFFF', ?, ?)`,
          [EMAIL, SLUG, club.name, `Welcome to ${club.name}`, c.primary || null, c.gold || c.glow || null,
            c.deep || null, a.lat || null, a.lng || null]);
        ok("members' app created");
      }
    }

    // How members sign in (the same rows as Loyalty App > Sign-in).
    try {
      const [rows] = await db.query('SELECT method FROM epos_loyalty_app_methods WHERE office = ?', [EMAIL]);
      if (rows.length) ok(`sign-in: ${rows.map((r) => r.method).join(', ')}`);
      else {
        todo('sign-in: emailed code, password, passkey, Continue with Vesopa');
        if (!CHECK) {
          const methods = ['code_email', 'password', 'passkey', 'vesopa'];
          await db.query('INSERT IGNORE INTO epos_loyalty_app_methods (office, method, enabled, sort_order) VALUES ?',
            [methods.map((m, i) => [EMAIL, m, 1, i])]);
          ok('sign-in methods set');
        }
      }
    } catch (e) {
      if (!missingTable(e)) throw e;
      console.log('  ! no epos_loyalty_app_methods table yet: emailed code only');
    }

    // The online menu's page (unpublished until the club is ready).
    if (office) {
      try {
        const [[menu]] = await db.query('SELECT slug, is_published FROM dinein_venue WHERE office_id = ? OR slug = ? LIMIT 1', [office.id, SLUG]);
        if (menu) ok(`menu page: ${menu.slug || '(no slug)'}, ${menu.is_published ? 'published' : 'not published'}`);
        else {
          todo(`menu page at slug ${SLUG} (not published)`);
          if (!CHECK) {
            const a = club.address || {};
            await db.execute(
              `INSERT INTO dinein_venue (office_id, slug, display_name, tagline, phone, address_line, postcode, accent_colour)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [office.id, SLUG, club.name, club.tagline || null, club.phone || null,
                [a.street, a.town].filter(Boolean).join(', ') || null, a.postcode || null,
                (club.colours && club.colours.primary) || '#A5C715']);
            ok('menu page created');
          }
        }
      } catch (e) {
        if (!missingTable(e)) throw e;
        console.log('  ! no dinein_venue table: menu page skipped');
      }
    }

    // Match tickets sold from the club's own website.
    try {
      const [[ev]] = await db.query('SELECT site_origins FROM epos_event_settings WHERE office = ?', [EMAIL]);
      const site = club.web && club.web.site;
      if (ev) ok('ticket settings exist');
      else if (site) {
        todo(`tickets from ${site}`);
        if (!CHECK) {
          const host = new URL(site).host;
          await db.execute(
            'INSERT INTO epos_event_settings (office, wru_org_id, home_name, site_origins, location) VALUES (?, ?, ?, ?, ?)',
            [EMAIL, club.wru_org_id || null, club.short_name || club.name.replace(/ RFC$/, ''),
              `https://${host},https://www.${host}`, club.ground || null]);
          ok('ticket settings created');
        }
      }
    } catch (e) {
      if (!missingTable(e)) throw e;
      console.log('  ! no epos_event_settings table: tickets skipped');
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(`club_venue: ${e.code || ''} ${String(e.message || e).slice(0, 200)}`);
  process.exit(1);
});
