/** Vesopa Gift, through vesopa_gift/src/admin_api.js. */
const { call } = require('../upstream');

module.exports = {
  venues: (as) => call('gift', 'GET', '/api/admin/venues', { as }).then((r) => r.venues || []),
  enable: (officeId, as) => call('gift', 'POST', `/api/admin/venues/${Number(officeId)}/enable`, { body: {}, as }),
  disable: (officeId, as) => call('gift', 'POST', `/api/admin/venues/${Number(officeId)}/disable`, { body: {}, as }),
};
