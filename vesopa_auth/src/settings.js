/**
 * Settings an administrator can change without a deploy.
 *
 * DELIBERATELY A SHORT LIST. Anything the application needs before it can serve
 * a request — a database password, a signing key, a pepper — belongs in the
 * environment, where somebody who is merely signed in cannot reach it. What
 * lives here is presentation and policy that a person running the service
 * should be able to change at four on a Friday without calling a developer.
 *
 * Cached for a minute. These are read on nearly every page render and change
 * perhaps twice a year, so a query each time would be a query for nothing —
 * but a minute is short enough that "I changed it and nothing happened" is
 * never true for long.
 */

const db = require('./db');

const CACHE_MS = 60000;
let cache = { at: 0, values: null };

/**
 * The settings that exist, what they may be, and what they mean.
 *
 * Anything not in here is refused by `set`. A settings table that will accept
 * any name at all becomes a junk drawer, and then a place where a typo silently
 * does nothing.
 */
const DEFINITIONS = {
  login_layout: {
    default: 'extended',
    options: ['extended', 'compact'],
    label: 'Sign-in page layout',
    help:
      'Extended names each provider on its own button and offers the ' +
      'Log in / Register wording. Compact shows the providers as icons and ' +
      'says "Continue" — because signing in and registering are the same ' +
      'action here, so the distinction only makes people hesitate.',
  },
  login_show_register_link: {
    default: 'yes',
    options: ['yes', 'no'],
    label: 'Show the Register link',
    help:
      'The link under the button that flips it between Log in and Register. ' +
      'It has no effect on what happens — the same form does both — so it can ' +
      'be turned off to keep the page simpler. Ignored in the compact layout, ' +
      'which never shows it.',
  },
  service_name: {
    default: 'Vesopa',
    options: null,
    label: 'Service name',
    help: 'What the sign-in page calls this service. "Sign in to ___".',
  },
};

/** Everything, with defaults filled in for anything unset. */
async function all() {
  if (cache.values && Date.now() - cache.at < CACHE_MS) return cache.values;

  const values = {};
  for (const [name, definition] of Object.entries(DEFINITIONS)) {
    values[name] = definition.default;
  }

  try {
    for (const row of await db.query('SELECT name, value FROM settings')) {
      // An unknown row is ignored rather than trusted: it may be left over from
      // a setting that has been removed, and reviving it by accident is worse
      // than losing it.
      if (!(row.name in DEFINITIONS)) continue;
      const definition = DEFINITIONS[row.name];
      if (definition.options && !definition.options.includes(row.value)) continue;
      if (row.value !== null && row.value !== '') values[row.name] = row.value;
    }
  } catch (error) {
    /*
     * A settings table that cannot be read must not take the sign-in page down.
     * Every one of these has a working default, so falling back to them is a
     * degraded service rather than no service.
     */
    console.error('[settings] could not be read, using defaults:', error.message);
  }

  cache = { at: Date.now(), values };
  return values;
}

async function get(name) {
  const values = await all();
  return values[name];
}

async function set(name, value, updatedBy = null) {
  const definition = DEFINITIONS[name];
  if (!definition) return { ok: false, error: 'unknown_setting' };
  if (definition.options && !definition.options.includes(value)) {
    return { ok: false, error: 'not_an_allowed_value' };
  }

  await db.execute(
    `INSERT INTO settings (name, value, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
    [name, String(value).slice(0, 2000), updatedBy],
  );

  cache = { at: 0, values: null };
  return { ok: true };
}

module.exports = { all, get, set, DEFINITIONS };
