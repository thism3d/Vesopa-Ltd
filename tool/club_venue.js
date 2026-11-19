/**
 * A club's venue in the Vesopa EPOS back office, made once and kept topped up
 * (owner, 2026-11-18/19: "create the back-office venue loughor-rfc", "give all
 * access to info@loughorrfc.site", "a review account test@test.com",
 * "manipulate with demo data like real data", "create the new Android
 * passes").
 *
 *   cd <back office folder> && node /path/club_venue.js club.json [backoffice.json] [--check] [--wallet]
 *
 * Run ON the Cloud box from the back office's own folder, so its .env (the
 * database login, Google Wallet's issuer) and node_modules (mysql2, bcryptjs,
 * dotenv) are used. Driven by tool/deploy_club_site.py, which uploads this
 * file, the club's website content/club.json and <club>/backoffice.json.
 *
 * The back-office password is read from the file named by CLUB_PASSWORD_FILE
 * (mode 600, deleted by the caller), never from the command line or printed.
 *
 * ONLY ADDS, except the password. Every row is looked for first and an
 * existing one is left as it is, so the club's own changes always win:
 *
 *   offices                   the venue (name, contact email = club.json email)
 *   backoffice_users          its login, that email, the owner's password
 *   bo_venue_modules          every module allowed and on ("all access")
 *   bo_licence_limits         Vesopa Go seats
 *   epos_loyalty_app          the members' app at the club's slug, on, in its colours
 *   epos_loyalty_app_methods  emailed code, password, passkey, Continue with Vesopa
 *   bo_tax_rates, bo_product_departments, bo_product_groups, bo_products
 *                             a club bar and kitchen (backoffice.json), when the
 *                             venue has no products yet
 *   dinein_venue, dinein_sections, dinein_items
 *                             the online menu from those, published
 *   epos_event_settings       ticket sales from the club's website
 *   epos_customers            the app stores' review member, with its password
 *   epos_wallet_settings      the Wallet card: name, crest, banner, colours
 *   (--wallet) Google Wallet  the venue's pass classes made or updated at Google
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

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const WALLET = args.includes('--wallet');
const [file, dataFile] = args.filter((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node club_venue.js club.json [backoffice.json] [--check] [--wallet]');
  process.exit(2);
}
const club = JSON.parse(fs.readFileSync(file, 'utf8'));
const data = dataFile && fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : {};
const SLUG = String(club.slug || '').trim();
const EMAIL = String(club.email || '').trim().toLowerCase();
if (!/^[a-z0-9-]{3,64}$/.test(SLUG) || !/^[^@\s]+@[^@\s]+$/.test(EMAIL)) {
  console.error('club.json needs slug and email');
  process.exit(2);
}
const PASSWORD = process.env.CLUB_PASSWORD_FILE && fs.existsSync(process.env.CLUB_PASSWORD_FILE)
  ? fs.readFileSync(process.env.CLUB_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '') : '';

const ok = (m) => console.log(`  ✓ ${m}`);
const todo = (m) => console.log(`  ${CHECK ? '! would' : '▶'} ${m}`);
const missingTable = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

/** One step; a table this database does not have yet is reported, not fatal. */
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    if (!missingTable(e)) throw e;
    console.log(`  ! ${name}: ${e.code} (that part of the schema is not on this server yet): ${String(e.sqlMessage || e.message || '').slice(0, 160)}`);
  }
}

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
    charset: 'utf8mb4',
  });
  const c = club.colours || {};
  const a = club.address || {};
  try {
    // ---- the venue and its login -------------------------------------------
    let [[office]] = await db.query('SELECT id, name FROM offices WHERE contact_email = ? ORDER BY id LIMIT 1', [EMAIL]);
    if (office) ok(`office ${office.id} "${office.name}"`);
    else {
      todo(`create office "${club.name}"`);
      if (!CHECK) {
        const [r] = await db.execute("INSERT INTO offices (name, contact_email, plan, status) VALUES (?, ?, NULL, 'active')", [club.name, EMAIL]);
        office = { id: r.insertId, name: club.name };
        ok(`office ${office.id} created`);
      }
    }
    if (!office) {
      console.log('check only: the rest follows once the office exists.');
      return;
    }

    const [[user]] = await db.query('SELECT id FROM backoffice_users WHERE email = ? LIMIT 1', [EMAIL]);
    const hash = PASSWORD ? await bcrypt.hash(PASSWORD, 12) : await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 12);
    if (user) {
      ok('back office login exists');
      if (PASSWORD) {
        todo("set the back office login's password (the owner's, from the secret)");
        if (!CHECK) await db.execute("UPDATE backoffice_users SET password = ?, approved = 'Y' WHERE id = ?", [hash, user.id]);
      }
    } else {
      todo(`create the back office login ${PASSWORD ? "with the owner's password" : '(random password; reset by email)'}`);
      if (!CHECK) {
        await db.execute(
          "INSERT INTO backoffice_users (email, password, name, company, approved, role, office_id) VALUES (?, ?, ?, ?, 'Y', 'office', ?)",
          [EMAIL, hash, club.name, club.company ? club.company.name : club.name, office.id]);
        ok('back office login created');
      }
    }

    // ---- all access ------------------------------------------------------------
    await step('modules', async () => {
      const { MODULES } = require(path.join(process.cwd(), 'src', 'modules.js'));
      for (const m of MODULES) {
        const [[row]] = await db.query('SELECT allowed, enabled FROM bo_venue_modules WHERE office_id = ? AND module = ?', [office.id, m.key]);
        if (row && row.allowed && row.enabled) { ok(`module ${m.key}: on`); continue; }
        todo(`module ${m.key}: allowed and on`);
        if (!CHECK) {
          await db.execute(
            `INSERT INTO bo_venue_modules (office_id, module, allowed, enabled, allowed_at, allowed_by, enabled_at, enabled_by)
             VALUES (?, ?, 1, 1, NOW(), 'club setup', NOW(), 'club setup')
             ON DUPLICATE KEY UPDATE allowed = 1, enabled = 1, allowed_at = COALESCE(allowed_at, NOW()), enabled_at = COALESCE(enabled_at, NOW())`,
            [office.id, m.key]);
        }
      }
    });
    if (data.go_seats) {
      await step('Go seats', async () => {
        const [[row]] = await db.query("SELECT seats FROM bo_licence_limits WHERE office = ? AND kind = 'go'", [EMAIL]);
        if (row && Number(row.seats) >= data.go_seats) { ok(`Vesopa Go: ${row.seats} seats`); return; }
        todo(`Vesopa Go: ${data.go_seats} seats`);
        if (!CHECK) {
          await db.execute(
            `INSERT INTO bo_licence_limits (office, kind, seats, source, status, updated_by)
             VALUES (?, 'go', ?, 'override', 'active', 'club setup')
             ON DUPLICATE KEY UPDATE seats = GREATEST(seats, VALUES(seats))`,
            [EMAIL, data.go_seats]);
        }
      });
    }

    // ---- the members' app ------------------------------------------------------
    const [[app]] = await db.query('SELECT office, slug, enabled FROM epos_loyalty_app WHERE slug = ? OR office = ? LIMIT 1', [SLUG, EMAIL]);
    if (app) ok(`members' app: slug ${app.slug || '(none)'}, ${app.enabled ? 'on' : 'off'}`);
    else {
      todo(`members' app at slug ${SLUG}`);
      if (!CHECK) {
        await db.execute(
          `INSERT INTO epos_loyalty_app (office, enabled, slug, app_name, welcome_text, logo_url, icon_url, colour_primary,
             colour_accent, colour_background, colour_text, latitude, longitude)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, '#FFFFFF', ?, ?)`,
          [EMAIL, SLUG, club.name, `Welcome to ${club.name}`,
            `https://backoffice.vesopaepos.com/assets/venues/${SLUG}/crest.png`,
            `https://backoffice.vesopaepos.com/assets/venues/${SLUG}/icon-512.png`,
            c.primary || null, c.gold || c.glow || null, c.deep || null, a.lat || null, a.lng || null]);
        ok("members' app created");
      }
    }
    await step('sign-in methods', async () => {
      const [rows] = await db.query('SELECT method FROM epos_loyalty_app_methods WHERE office = ?', [EMAIL]);
      if (rows.length) { ok(`sign-in: ${rows.map((r) => r.method).join(', ')}`); return; }
      todo('sign-in: emailed code, password, passkey, Continue with Vesopa');
      if (!CHECK) {
        await db.query('INSERT IGNORE INTO epos_loyalty_app_methods (office, method, enabled, sort_order) VALUES ?',
          [['code_email', 'password', 'passkey', 'vesopa'].map((m, i) => [EMAIL, m, 1, i])]);
      }
    });

    // ---- the club's bar and kitchen ----------------------------------------
    if (Array.isArray(data.products) && data.products.length) {
      await step('catalogue', async () => {
        const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM bo_products WHERE email = ?', [EMAIL]);
        if (n > 0) { ok(`catalogue: ${n} products (the club's own; nothing added)`); return; }
        todo(`catalogue: ${data.products.length} products in ${data.departments.length} departments`);
        if (CHECK) return;
        // Only the columns this database has (the live schema can be older
        // than the repository's), and nothing added twice: a run that stopped
        // half way is finished, not repeated.
        const cols = async (table) => {
          const [rows] = await db.query(
            'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
          return new Set(rows.map((r) => r.c));
        };
        const insert = async (table, row) => {
          const have = await cols(table);
          if (!have.size) { console.log(`  ! no ${table} table: skipped`); return false; }
          const keys = Object.keys(row).filter((k) => have.has(k));
          await db.execute(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
            keys.map((k) => row[k]));
          return true;
        };
        // The live tables can be keyed by the office's id or by its email
        // (the older back office): each row carries both and keeps what the
        // table has; a name column may be called name or <thing>_name.
        const keyOf = (have) => (have.has('office_id') ? ['office_id', office.id] : have.has('email') ? ['email', EMAIL] : have.has('office') ? ['office', EMAIL] : null);
        const lists = [['bo_tax_rates', data.tax_rates || [], (t, i) => ({ name: t.name, tax_name: t.name, percentage: t.percentage, rate: t.percentage, sort_order: t.sort_order ?? i + 1 })],
          ['bo_product_departments', data.departments || [], (d, i) => ({ name: d, department_name: d, sort_order: i + 1 })],
          ['bo_product_groups', data.groups || [], (g, i) => ({ name: g, group_name: g, sort_order: i + 1 })]];
        for (const [table, items, row] of lists) {
          const have = await cols(table);
          const key = keyOf(have);
          const nameCol = ['name', 'department_name', 'group_name', 'tax_name'].find((c) => have.has(c));
          if (!have.size || !key || !nameCol) { console.log(`  ! ${table}: not a shape this knows (skipped)`); continue; }
          for (const [i, item] of items.entries()) {
            const r = { [key[0]]: key[1], ...row(item, i) };
            const [[had]] = await db.query(`SELECT 1 AS x FROM ${table} WHERE ${key[0]} = ? AND ${nameCol} = ? LIMIT 1`, [key[1], r[nameCol]]);
            if (!had) await insert(table, r);
          }
        }
        let added = 0;
        for (const [i, p] of data.products.entries()) {
          const [[had]] = await db.query('SELECT 1 AS x FROM bo_products WHERE email = ? AND pluid = ? LIMIT 1', [EMAIL, p.pluid]);
          if (had) continue;
          await insert('bo_products', {
            email: EMAIL, pluid: p.pluid, product_name: p.product_name, department_name: p.department_name,
            group_name: p.group_name, price: p.price, tax_percentage: p.tax_percentage ?? 20, stock_quantity: null,
            button_position: i + 1, button_color: p.button_color || null, print_to_receipt: 1, emoji: p.emoji || null,
          });
          added += 1;
        }
        console.log(`  ✓ ${added} products added`);
        ok('catalogue added');
      });
    }

    // ---- the online menu ---------------------------------------------------------
    await step('online menu', async () => {
      const [[menu]] = await db.query('SELECT office_id, slug, is_published FROM dinein_venue WHERE office_id = ? OR slug = ? LIMIT 1', [office.id, SLUG]);
      if (menu) ok(`menu page: ${menu.slug || '(no slug)'}, ${menu.is_published ? 'published' : 'not published'}`);
      else {
        todo(`menu page at slug ${SLUG}, published, ordering to tables and for collection`);
        if (!CHECK) {
          await db.execute(
            `INSERT INTO dinein_venue (office_id, slug, display_name, tagline, phone, address_line, postcode, accent_colour,
               is_published, ordering_open, collection_open, collection_minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 20)`,
            [office.id, SLUG, club.name, club.tagline || null, club.phone || null,
              [a.street, a.town].filter(Boolean).join(', ') || null, a.postcode || null, c.primary || '#A5C715']);
        }
      }
      const [[{ s }]] = await db.query('SELECT COUNT(*) AS s FROM dinein_sections WHERE office_id = ?', [office.id]);
      if (s > 0 || !Array.isArray(data.menu)) { if (s > 0) ok(`menu: ${s} sections`); return; }
      todo(`menu: ${data.menu.length} sections from the catalogue`);
      if (CHECK) return;
      for (const [i, sec] of data.menu.entries()) {
        const [r] = await db.execute('INSERT INTO dinein_sections (office_id, name, blurb, image_url, sort_order) VALUES (?, ?, ?, NULL, ?)',
          [office.id, sec.name, sec.blurb || null, i + 1]);
        const items = (data.products || []).filter((p) => sec.groups.includes(p.group_name));
        for (const [j, p] of items.entries()) {
          await db.execute('INSERT INTO dinein_items (section_id, office_id, plu_id, name, sort_order) VALUES (?, ?, ?, ?, ?)',
            [r.insertId, office.id, p.pluid, p.product_name, j + 1]);
        }
      }
      ok('menu sections added');
    });

    // ---- match tickets from the club's website -----------------------------
    await step('tickets', async () => {
      const [[ev]] = await db.query('SELECT office FROM epos_event_settings WHERE office = ?', [EMAIL]);
      const site = club.web && club.web.site;
      if (ev) { ok('ticket settings exist'); return; }
      if (!site) return;
      todo(`tickets from ${site}`);
      if (!CHECK) {
        const host = new URL(site).host;
        await db.execute(
          'INSERT INTO epos_event_settings (office, wru_org_id, home_name, site_origins, location) VALUES (?, ?, ?, ?, ?)',
          [EMAIL, club.wru_org_id || null, club.short_name || club.name.replace(/ RFC$/, ''),
            `https://${host},https://www.${host}`, club.ground || null]);
      }
    });

    // ---- the app stores' review member ---------------------------------------
    const review = data.review_member;
    if (review && /@test\.com$/i.test(review.email || '')) {
      await step('review member', async () => {
        const email = review.email.toLowerCase();
        const [rows] = await db.query('SELECT id FROM epos_customers WHERE email_key = ? AND LOWER(email) = ? LIMIT 1', [EMAIL, email]);
        const h = await bcrypt.hash(String(review.password), 10);
        if (rows.length) {
          ok(`review member ${email} exists`);
          if (!CHECK) await db.execute('UPDATE epos_customers SET password_hash = ?, password_set_at = NOW() WHERE id = ?', [h, rows[0].id]);
        } else {
          todo(`review member ${email}, with a password`);
          if (!CHECK) {
            await db.execute(
              `INSERT INTO epos_customers (id, email_key, name, email, notes, password_hash, password_set_at)
               VALUES (?, ?, ?, ?, 'App store review account', ?, NOW())`,
              [crypto.randomUUID(), EMAIL, review.name || 'App Review', email, h]);
          }
        }
      });
    }

    // ---- the Wallet card -----------------------------------------------------
    const w = data.wallet;
    if (w) {
      await step('wallet settings', async () => {
        const [[row]] = await db.query('SELECT office FROM epos_wallet_settings WHERE office = ?', [EMAIL]);
        if (row) { ok('Wallet card settings exist'); return; }
        todo(`Wallet card "${w.program_name}"`);
        if (!CHECK) {
          await db.execute(
            `INSERT INTO epos_wallet_settings (office, enabled, program_name, issuer_name, logo_url, hero_url, hex_background,
               homepage_url, support_phone, terms, loyalty_enabled)
             VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [EMAIL, w.program_name, w.issuer_name, w.logo_url, w.hero_url, w.hex_background, w.homepage_url,
              w.support_phone, w.terms || null]);
        }
      });
      if (WALLET && !CHECK) await googleClasses(db, w);
    }
  } finally {
    await db.end();
  }
}

/** The venue's Google Wallet pass classes, made or updated at Google now. */
async function googleClasses(db, w) {
  const G = require(path.join(process.cwd(), 'src', 'wallet_google.js'));
  const config = G.readConfig ? G.readConfig(process.env) : null;
  if (!config || !config.configured) {
    console.log(`  ! Google Wallet: not configured on this server${config ? ` (${config.problems.join('; ')})` : ''}`);
    return;
  }
  const client = G.makeClient(config);
  const brand = {
    office: EMAIL, ...w, hex_foreground: '#FFFFFF', hex_label: (club.colours && club.colours.gold) || '#F5C518', look_art: SLUG,
  };
  for (const kind of ['loyalty', 'customer']) {
    const built = G.buildPass({ kind, config, office: EMAIL, brand, subject: { id: 'template' } });
    let review = config.reviewStatus;
    let error = null;
    try {
      const saved = await client.upsertClass(kind, built.klass);
      review = (saved && saved.reviewStatus) || review;
      ok(`Google Wallet ${kind} class ${built.classId}: ${review}`);
    } catch (e) {
      error = String(e.message || e).slice(0, 500);
      console.log(`  ! Google Wallet ${kind} class: ${error.slice(0, 200)}`);
    }
    await step('wallet classes', () => db.execute(
      `INSERT INTO epos_wallet_classes (office, kind, class_id, review_status, last_error, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE class_id = VALUES(class_id), review_status = VALUES(review_status),
         last_error = VALUES(last_error), synced_at = VALUES(synced_at)`,
      [EMAIL, kind, built.classId, review, error, error ? null : new Date()]));
  }
}

main().catch((e) => {
  console.error(`club_venue: ${e.code || ''} ${String(e.message || e).slice(0, 200)}`);
  process.exit(1);
});
