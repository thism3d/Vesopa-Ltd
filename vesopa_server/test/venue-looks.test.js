'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { lookFor, pageMeta, artFor } = require('../src/venue_looks');

test('Pontardawe RFC has the club look; other venues have none', () => {
  const look = lookFor('pontardawe-rfc');
  assert.equal(look.club, '#8F0000');
  assert.equal(look.font, 'montserrat');
  assert.equal(lookFor('PONTARDAWE-RFC'), look);
  // Its cards carry its own name, not the receipt's (2026-10-15).
  assert.equal(look.name, 'Pontardawe RFC');
  assert.equal(lookFor('thevesopakitchen'), null);
  assert.equal(lookFor(''), null);
});

test('the page carries the look only for a venue that has one', () => {
  assert.equal(pageMeta('pontardawe-rfc'), '<meta name="vesopa-look" content="#8F0000,#3F0000,#C41414">');
  assert.equal(pageMeta('thevesopakitchen'), '');
  assert.equal(pageMeta('a"><script>'), '');
});

test("the club's own icons are files that exist; other venues have none", () => {
  for (const slug of ['pontardawe-rfc', 'loughor-rfc']) {
    const art = artFor(slug);
    assert.ok(art, slug);
    for (const p of Object.values(art)) {
      // The address carries a ?v= cache-buster; the file is the path before it.
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', p.split('?')[0])), p);
    }
  }
  assert.equal(artFor('thevesopakitchen'), null);
});
