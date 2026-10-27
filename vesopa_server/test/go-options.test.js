// Vesopa Go's options: typed, bounded, unknown keys dropped (src/go_options.js).
const assert = require('assert');
const { GO_DEFAULTS, cleanGoOptions } = require('../src/go_options');

const d = cleanGoOptions({});
assert.deepStrictEqual(d, { ...GO_DEFAULTS });
const c = cleanGoOptions({
  order_mode: 'send_to_till', stack_lines: 'nope', idle_seconds: '99999', sound_add: -4,
  login_nfc: 0, note_chips: ' No ice , , Well done ', layout_tablet: [3, '7', 'x', -1], evil: 'drop me',
});
assert.strictEqual(c.order_mode, 'send_to_till');
assert.strictEqual(c.stack_lines, 'till');
assert.strictEqual(c.idle_seconds, 3600);
assert.strictEqual(c.sound_add, 0);
assert.strictEqual(c.login_nfc, false);
assert.strictEqual(c.note_chips, 'No ice,Well done');
assert.strictEqual(c.layout_tablet, '[3,7]');
assert.ok(!('evil' in c));
// A partial save keeps what was there.
assert.strictEqual(cleanGoOptions({ haptics: false }, c).order_mode, 'send_to_till');
console.log('go-options.test.js: all passed');
