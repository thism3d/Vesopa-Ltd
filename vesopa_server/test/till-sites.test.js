/**
 * The site filter every dashboard query is narrowed by (src/till_sites.js).
 */
'use strict';

const assert = require('assert');
const { siteScope } = require('../src/till_sites');

(async () => {
  const office = 'venue@example.com';
  const all = await siteScope(null, office, {}, 'o.');
  assert.strictEqual(all.sql, '');
  assert.deepStrictEqual(all.params, []);

  const site = await siteScope(null, office, { site: '7' }, 'o.');
  assert.match(site.sql, /o\.terminal IN \(SELECT terminal FROM bo_till_names WHERE office = \? AND site_id = \?\)/);
  assert.deepStrictEqual(site.params, [office, 7]);

  const till = await siteScope(null, office, { till: 'DESKTOP-1' }, '');
  assert.strictEqual(till.sql, ' AND terminal = ?');
  assert.deepStrictEqual(till.params, ['DESKTOP-1']);

  const none = await siteScope(null, office, { site: 'none' }, 'o.');
  assert.match(none.sql, /o\.terminal IS NULL OR o\.terminal NOT IN/);
  assert.deepStrictEqual(none.params, [office]);

  // Anything else is ignored, never interpolated.
  const odd = await siteScope(null, office, { site: "1 OR 1=1" }, 'o.');
  assert.strictEqual(odd.sql, '');

  console.log('till-sites: 5 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
