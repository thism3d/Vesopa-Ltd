/**
 * Settings Metric's staff choose in the console (Appearance), with the value
 * each has until somebody does. Read by the member app through /api/v1/brand.
 */

const db = require('./db');
const { THEMES } = require('./themes');

const CHOICES = {
  // How number plates are drawn in the app and the console: Metric's navy
  // plate (the default), the yellow UK rear plate, or the white front plate.
  plateStyle: { values: ['metric', 'uk_yellow', 'uk_white'], fallback: 'metric' },
  // The colours of the phone's top and bottom bars around the app (themes.js),
  // and whether the top one slowly moves through its gradient.
  appTheme: { values: Object.keys(THEMES), fallback: 'metric' },
  barMotion: { values: ['animated', 'still'], fallback: 'animated' },
};

async function all() {
  const out = Object.fromEntries(Object.entries(CHOICES).map(([k, c]) => [k, c.fallback]));
  const rows = await db.all('SELECT name, value FROM settings').catch(() => []);
  for (const r of rows) if (CHOICES[r.name] && CHOICES[r.name].values.includes(r.value)) out[r.name] = r.value;
  return out;
}

/** Returns null when the value is not one of the choices. */
async function set(name, value, by) {
  const c = CHOICES[name];
  if (!c || !c.values.includes(value)) return null;
  await db.run(
    'INSERT INTO settings (name, value, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)',
    [name, value, String(by || '').slice(0, 191)],
  );
  return value;
}

module.exports = { CHOICES, all, set };
