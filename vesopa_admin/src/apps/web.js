/**
 * vesopaepos.com subscriptions (Dojo billing), through
 * vesopa_web/src/routes/subscriptions.js (/api/subs, Bearer SUBS_SERVICE_KEY).
 */
const { call } = require('../upstream');

module.exports = {
  list: (status, as) => call('web', 'GET', `/api/subs${status ? `?status=${encodeURIComponent(status)}` : ''}`, { as }),
  detail: (id, as) => call('web', 'GET', `/api/subs/${Number(id)}`, { as }),
  plans: (as) => call('web', 'GET', '/api/subs/plans', { as }),
  act: (id, action, body, as) => call('web', 'POST', `/api/subs/${Number(id)}/${encodeURIComponent(action)}`, { body: body || {}, as, timeout: 45000 }),
};
