/**
 * iPhone notifications for a venue with its own app: the bundle ids tried.
 *
 * A token sent under the wrong app's topic is refused with
 * DeviceTokenNotForTopic, which the sender treats as "this phone is gone" --
 * so getting the order or the fallback wrong silently unsubscribes members.
 */
const assert = require('assert');

process.env.APNS_TOPICS = 'pontardawe-rfc=com.vesopaepos.pontardawerfc, other-venue = com.example.other';
const { apnsTopics } = require('../src/loyalty_push');

const shared = 'com.vesopaepos.thevesopakitchen';

assert.deepStrictEqual(apnsTopics('pontardawe-rfc', shared), ['com.vesopaepos.pontardawerfc', shared],
  "a venue's own app first, the shared app after it");
assert.deepStrictEqual(apnsTopics('other-venue', shared), ['com.example.other', shared], 'spaces around = and , are ignored');
assert.deepStrictEqual(apnsTopics('thevesopakitchen', shared), [shared], 'a venue without its own app uses the shared one');
assert.deepStrictEqual(apnsTopics('', shared), [shared], 'no slug: the shared app');

process.env.APNS_TOPICS = 'thevesopakitchen=' + shared;
assert.deepStrictEqual(apnsTopics('thevesopakitchen', shared), [shared], 'never the same topic twice');

console.log('loyalty-apns-topics: ok');
