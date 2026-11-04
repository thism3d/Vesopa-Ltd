// What an uploaded display advert really is, from its bytes (src/display_adverts.js).
const assert = require('assert');
const { sniff } = require('../src/display_adverts');

const bytes = (...b) => Buffer.from([...b, ...new Array(16).fill(0)]);
assert.strictEqual(sniff(bytes(0x89, 0x50, 0x4e, 0x47)), 'image/png');
assert.strictEqual(sniff(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
assert.strictEqual(sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
assert.strictEqual(sniff(Buffer.from('GIF89a........')), 'image/gif');
assert.strictEqual(sniff(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(4)])), 'video/mp4');
assert.strictEqual(sniff(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypqt  '), Buffer.alloc(4)])), 'video/quicktime');
assert.strictEqual(sniff(Buffer.from('<html><script>')), null, 'a page named .png is refused');
assert.strictEqual(sniff(Buffer.alloc(3)), null);
console.log('display-adverts.test.js: all passed');
