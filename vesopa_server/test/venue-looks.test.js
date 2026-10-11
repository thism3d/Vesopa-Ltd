'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { lookFor, pageMeta } = require('../src/venue_looks');

test('Pontardawe RFC has the club look; other venues have none', () => {
  const look = lookFor('pontardawe-rfc');
  assert.equal(look.club, '#8F0000');
  assert.equal(look.font, 'montserrat');
  assert.equal(lookFor('PONTARDAWE-RFC'), look);
  assert.equal(lookFor('thevesopakitchen'), null);
  assert.equal(lookFor(''), null);
});

test('the page carries the look only for a venue that has one', () => {
  assert.equal(pageMeta('pontardawe-rfc'), '<meta name="vesopa-look" content="#8F0000,#3F0000,#C41414">');
  assert.equal(pageMeta('thevesopakitchen'), '');
  assert.equal(pageMeta('a"><script>'), '');
});
