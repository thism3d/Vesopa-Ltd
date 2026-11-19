/**
 * What Google reads about a product (owner, 2026-11-19: Search Console's
 * merchant listings wanted shippingDetails and hasMerchantReturnPolicy;
 * Merchant Center wanted a shipping weight).
 *
 *     node --test test/hardware-ld.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const hw = require('../src/hardware-catalogue');

const SITE = 'https://vesopaepos.com';

test('every product says how it is delivered and how it can be returned', () => {
  for (const p of hw.PRODUCTS) {
    const ld = hw.productLd(p, SITE);
    const o = ld.offers;
    assert.ok(o.shippingDetails.length >= 1, p.sku);
    for (const s of o.shippingDetails) {
      assert.equal(s.shippingDestination.addressCountry, 'GB');
      assert.equal(s.shippingRate.currency, 'GBP');
      assert.equal(s.deliveryTime.transitTime.unitCode, 'DAY');
    }
    assert.equal(o.hasMerchantReturnPolicy.merchantReturnDays, 14);
    assert.equal(o.hasMerchantReturnPolicy.applicableCountry, 'GB');
    assert.equal(o.url, `${SITE}/hardware/${p.slug}`);
    assert.equal(ld.aggregateRating, undefined, 'no made-up rating');
    assert.equal(new Set(ld.image).size, ld.image.length, 'no photo twice');
  }
});

test('delivery as the checkout charges it: free from UK stock, else standard and express with VAT', () => {
  const inUk = hw.productLd(hw.bySku('OCPP-80A'), SITE).offers.shippingDetails;
  assert.deepEqual(inUk.map((s) => s.shippingRate.value), [0]);
  const shipped = hw.productLd(hw.bySku('POS-K01'), SITE).offers.shippingDetails;
  assert.deepEqual(shipped.map((s) => s.shippingRate.value), [114, 276]);
});

test("the weight where the supplier gives one, never a guess", () => {
  assert.deepEqual(hw.weightOf(hw.bySku('POS-1566')), { '@type': 'QuantitativeValue', value: 3.5, unitCode: 'KGM' });
  assert.deepEqual(hw.weightOf(hw.bySku('OCBS-T2182D')), { '@type': 'QuantitativeValue', value: 249, unitCode: 'GRM' });
  assert.equal(hw.weightOf(hw.bySku('POS-K01')), null);
  assert.equal(hw.productLd(hw.bySku('POS-K01'), SITE).weight, undefined);
});
