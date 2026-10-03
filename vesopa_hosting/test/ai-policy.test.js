// node --test test/ai-policy.test.js
// The Vesopa model policy as it applies here: what counts as personal, what
// is stripped before DeepSeek sees a page, and Studio's contact masking.
const test = require('node:test');
const assert = require('node:assert');
const llm = require('../src/ai/llm');
const { contactMask } = require('../src/builder/agent');

test('a page with personal details typed in counts as personal', () => {
  assert.strictEqual(llm.pageHasPersonal({ elements: [{ ref: 'e1', name: 'domain', value: 'bakery.co.uk' }] }), false);
  assert.strictEqual(llm.pageHasPersonal({ elements: [{ ref: 'e1', name: 'first_name', value: 'Jo' }] }), true);
  assert.strictEqual(llm.pageHasPersonal({ elements: [{ ref: 'e1', kind: 'input', label: 'Postcode', value: 'SA12 7AX' }] }), true);
  assert.strictEqual(llm.pageHasPersonal({ text: 'Signed in as jo@bakery.co.uk' }), true);
  assert.strictEqual(llm.pageHasPersonal({ elements: [{ ref: 'e2', name: 'email', value: '' }] }), false);
});

test('the safe page keeps controls and drops what was typed into personal fields', () => {
  const page = llm.safePage({
    url: '/checkout', text: 'Ring 01792 316282', alerts: ['Sent to jo@bakery.co.uk'],
    elements: [{ ref: 'e1', name: 'domain', value: 'bakery.co.uk' }, { ref: 'e2', name: 'phone', value: '01792 316282' }],
  });
  assert.strictEqual(page.elements[0].value, 'bakery.co.uk');
  assert.strictEqual(page.elements[1].value, '[filled in]');
  assert.ok(!page.text.includes('316282'));
  assert.ok(!page.alerts[0].includes('jo@'));
  assert.strictEqual(page.elements[1].ref, 'e2');
});

test('Studio masks contact details on the way out and restores them on the way back', () => {
  const m = contactMask(['Call 01639 123456 or email Jo@SharpCuts.co.uk', '<a href="tel:01639123456">01639 123456</a>']);
  const sent = m.mask('Call 01639 123456 or email Jo@SharpCuts.co.uk');
  assert.ok(!sent.includes('123456') && !sent.toLowerCase().includes('sharpcuts'));
  assert.ok(sent.includes('07000 000001') && sent.includes('contact1@example.com'));
  const back = m.unmask('<a href="tel:07000000001">07000 000001</a> <a href="mailto:contact1@example.com">contact1@example.com</a>');
  assert.ok(back.includes('tel:01639123456'));
  assert.ok(back.includes('>01639 123456<'));
  assert.ok(back.includes('mailto:Jo@SharpCuts.co.uk'));
});

test('a Studio message with no contact details is sent unchanged', () => {
  const m = contactMask(['A website for my bakery in Swansea, prices from £4.50']);
  assert.strictEqual(m.any, false);
  assert.strictEqual(m.mask('A website for my bakery in Swansea, prices from £4.50'), 'A website for my bakery in Swansea, prices from £4.50');
});
