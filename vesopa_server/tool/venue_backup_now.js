/**
 * Back up now, from the back office folder on the server (src/venue_backup.js).
 *
 *   node tool/venue_backup_now.js 35        # one venue (office id)
 *   node tool/venue_backup_now.js all       # the nightly run: full dump, every venue, prune
 *   node tool/venue_backup_now.js full      # the full database and schema only
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const mysql = require('mysql2/promise');
const b = require('../src/venue_backup');

(async () => {
  const what = process.argv[2] || '';
  const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
  });
  try {
    if (what === 'all') {
      const r = await b.backupAll(db);
      console.log(JSON.stringify({ venues: r.venues.length, failed: r.failed, seconds: r.seconds }));
    } else if (what === 'full') {
      console.log(JSON.stringify(await b.backupFull()));
    } else if (/^\d+$/.test(what)) {
      const [[v]] = await db.query('SELECT id, name, contact_email AS email FROM offices WHERE id = ?', [Number(what)]);
      if (!v) throw new Error('no such office');
      const m = await b.backupVenue(db, v, { reason: 'manual', by: process.env.BACKUP_BY || 'command line' });
      const top = Object.entries(m.tables).filter(([, n]) => n).sort((x, y) => y[1] - x[1]).slice(0, 8);
      console.log(JSON.stringify({ venue: v.name, file: m.file, rows: m.rows, bytes: m.bytes, sha256: m.sha256.slice(0, 12), biggest: Object.fromEntries(top) }));
    } else {
      throw new Error('usage: venue_backup_now.js <office id> | all | full');
    }
  } finally {
    await db.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
