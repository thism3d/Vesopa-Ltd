/** Vesopa Cloud hosting, through vesopa_hosting/src/routes/admin_api.js. */
const { call } = require('../upstream');

module.exports = {
  services: (as) => call('hosting', 'GET', '/api/admin/services', { as }).then((r) => r.services || []),
  suspend: (id, reason, as) => call('hosting', 'POST', `/api/admin/services/${Number(id)}/suspend`, { body: { reason }, as }),
  unsuspend: (id, as) => call('hosting', 'POST', `/api/admin/services/${Number(id)}/unsuspend`, { body: {}, as }),
};
