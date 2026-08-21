/**
 * The kitchen-login and screen editors in the back office.
 *
 * These could not add anything. The editors were chains of three and five
 * `prompt()` calls, and a browser that has been told to stop showing dialogs —
 * Chrome offers that tick box on the *second* dialog, which is precisely where
 * a chain puts it — returns null from every later one. The function bailed at
 * its first null check and did nothing, and the `alert()` that would have
 * explained was suppressed by the same setting.
 *
 * They are modal forms now, like every other editor on the site. There is no
 * DOM here and no browser: `modal()` and `api()` are stubbed, the two editors
 * are lifted out of public/app.js and run, and what is asserted is the request
 * body they build — which is where the interesting cases are. A checkbox set
 * submits a string for one tick, an array for several, and nothing at all for
 * none, and "none" means "every station" rather than "no stations".
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'app.js'),
  'utf8'
);
const from = source.indexOf('function kdsEditUser(user) {');
assert.ok(from > 0, 'kdsEditUser not found in public/app.js');

/**
 * Run the editors with the browser stubbed out.
 *
 * Returns the modal it opened and the calls it made, so a test can fill the
 * form in and then read what went to the server.
 */
function harness() {
  const calls = [];
  let opened = null;

  const context = {
    KDS_STATIONS: ['kp1', 'kp2', 'kp3', 'kp4', 'kp5', 'kp6'],
    kdsSettings: { printer_name_kp1: 'Grill' },
    api: async (url, options) => {
      calls.push({ url, ...options, body: JSON.parse(options.body) });
      return {};
    },
    modal: (title, fields, onSubmit) => {
      opened = { title, fields, onSubmit };
    },
  };
  context.kdsLabel = (s) =>
    String(context.kdsSettings['printer_name_' + s] || '').trim() ||
    s.toUpperCase().replace('KP', 'KP ');

  vm.createContext(context);
  vm.runInContext(source.slice(from), context);
  return {
    calls,
    editUser: (user) => {
      context.kdsEditUser(user);
      return opened;
    },
    editScreen: (screen) => {
      context.kdsEditScreen(screen);
      return opened;
    },
  };
}

const field = (m, name) => m.fields.find((f) => f.name === name);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('\nback office: the kitchen editors\n');

  await check('a new login asks for a username, and sends it', async () => {
    const h = harness();
    const m = h.editUser(null);
    assert.ok(field(m, 'username'), 'a create must offer the username');
    await m.onSubmit({
      username: 'manager@vesopa.co.uk',
      password: 'Kitchen-2026',
      display_name: 'Office screen',
    });
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.calls[0].method, 'POST');
    assert.strictEqual(h.calls[0].url, '/kitchen/users');
    assert.strictEqual(h.calls[0].body.username, 'manager@vesopa.co.uk');
  });

  await check('an edit cannot rename the login', async () => {
    // The server has never accepted a username change, and a rename would
    // sign a kitchen out with no warning. So the field is not on the form.
    const h = harness();
    const m = h.editUser({ id: 4, username: 'grill', active: 1 });
    assert.strictEqual(field(m, 'username'), undefined);
    assert.ok(m.title.includes('grill'), 'the title says which one');
  });

  await check('a blank password on an edit is left alone', async () => {
    const h = harness();
    const m = h.editUser({ id: 4, username: 'grill', active: 1 });
    await m.onSubmit({ display_name: 'Grill', password: '', active: '1' });
    assert.strictEqual(h.calls[0].method, 'PUT');
    assert.ok(
      !('password' in h.calls[0].body),
      'an empty box must not be sent as a password change'
    );
  });

  await check('a typed password on an edit is sent', async () => {
    const h = harness();
    const m = h.editUser({ id: 4, username: 'grill', active: 1 });
    await m.onSubmit({
      display_name: 'Grill',
      password: 'new-one',
      active: '1',
    });
    assert.strictEqual(h.calls[0].body.password, 'new-one');
  });

  await check('the active box becomes a boolean, not the string "0"', async () => {
    // The hidden field behind the checkbox submits "0", and "0" is truthy.
    const h = harness();
    const m = h.editUser({ id: 4, username: 'grill', active: 1 });
    await m.onSubmit({ display_name: 'Grill', password: '', active: '0' });
    assert.strictEqual(h.calls[0].body.active, false);
  });

  await check('a screen with no station ticked watches every station', async () => {
    const h = harness();
    const m = h.editScreen(null);
    await m.onSubmit({
      name: 'Pass',
      warn_minutes: '8',
      late_minutes: '15',
      recall_minutes: '60',
      columns_count: '0',
      sound: '1',
      // `stations` is absent: an unticked checkbox set does not submit.
    });
    assert.deepStrictEqual(h.calls[0].body.stations, []);
    assert.strictEqual(h.calls[0].method, 'POST');
  });

  await check('one station ticked is still a list', async () => {
    const h = harness();
    const m = h.editScreen(null);
    await m.onSubmit({
      name: 'Grill',
      stations: 'kp1',
      warn_minutes: '8',
      late_minutes: '15',
      recall_minutes: '60',
      columns_count: '0',
      sound: '1',
    });
    assert.deepStrictEqual(h.calls[0].body.stations, ['kp1']);
  });

  await check('several stations come through in order', async () => {
    const h = harness();
    const m = h.editScreen(null);
    await m.onSubmit({
      name: 'Grill',
      stations: ['kp1', 'kp3'],
      warn_minutes: '8',
      late_minutes: '15',
      recall_minutes: '60',
      columns_count: '0',
      sound: '1',
    });
    assert.deepStrictEqual(h.calls[0].body.stations, ['kp1', 'kp3']);
  });

  await check('minutes on the form become seconds on the wire', async () => {
    const h = harness();
    const m = h.editScreen(null);
    await m.onSubmit({
      name: 'Grill',
      stations: [],
      warn_minutes: '8',
      late_minutes: '15',
      recall_minutes: '45',
      columns_count: '3',
      sound: '0',
    });
    const body = h.calls[0].body;
    assert.strictEqual(body.warn_seconds, 480);
    assert.strictEqual(body.late_seconds, 900);
    assert.strictEqual(body.recall_minutes, 45);
    assert.strictEqual(body.columns_count, 3);
    assert.strictEqual(body.sound, false, 'the server reads only false as off');
  });

  await check('an edit puts the current values on the form', async () => {
    const h = harness();
    const m = h.editScreen({
      id: 7,
      name: 'Grill',
      stations: ['kp1', 'kp3'],
      warn_seconds: 480,
      late_seconds: 900,
      recall_minutes: 60,
      columns_count: 2,
      sound: 0,
    });
    assert.strictEqual(field(m, 'name').value, 'Grill');
    assert.strictEqual(field(m, 'stations').value, 'kp1,kp3');
    assert.strictEqual(field(m, 'warn_minutes').value, 8);
    assert.strictEqual(field(m, 'columns_count').value, 2);
    assert.strictEqual(field(m, 'sound').value, 0);

    await m.onSubmit({
      name: 'Grill',
      stations: ['kp1', 'kp3'],
      warn_minutes: '8',
      late_minutes: '15',
      recall_minutes: '60',
      columns_count: '2',
      sound: '0',
    });
    assert.strictEqual(h.calls[0].method, 'PUT');
    assert.strictEqual(h.calls[0].url, '/kitchen/screens/7');
  });

  await check('the station boxes carry the venue’s own names', async () => {
    // KP 1 is called "Grill" at this venue, and that is what a manager is
    // looking for on the form rather than "KP 1".
    const h = harness();
    const m = h.editScreen(null);
    const labels = field(m, 'stations').options.map((o) => o.label);
    assert.strictEqual(labels[0], 'Grill');
    assert.strictEqual(labels[1], 'KP 2');
  });

  await check('no editor calls prompt', async () => {
    // The regression itself. If a chain of dialogs ever comes back, this is
    // the check that says so.
    // Comments stripped first: the ones above name `prompt()` to explain why
    // it is gone, and matching those would make this check unfailable.
    const code = source
      .slice(from)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(
      !/\bprompt\s*\(/.test(code),
      'the kitchen editors must not use prompt()'
    );
  });

  console.log(`\n${passed} checks passed`);
})();
