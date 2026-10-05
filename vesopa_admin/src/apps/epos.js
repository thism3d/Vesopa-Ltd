/**
 * The back office (vesopa_server), through its existing /api/admin routes on
 * ADMIN_SERVICE_KEY. Nothing here is new behaviour in the back office: these
 * are the calls its own Admin screens make.
 */
const { call } = require('../upstream');

const get = (path, as) => call('epos', 'GET', `/api/admin${path}`, { as });
const put = (path, body, as) => call('epos', 'PUT', `/api/admin${path}`, { body, as });
const post = (path, body, as) => call('epos', 'POST', `/api/admin${path}`, { body, as });

module.exports = {
  overview: (as) => get('/overview', as),
  licences: (as) => get('/licences', as),
  limits: (id, as) => get(`/offices/${Number(id)}/licence-limits`, as),
  setLimits: (id, limits, as) => put(`/offices/${Number(id)}/licence-limits`, limits, as),
  issueKey: (id, body, as) => post(`/offices/${Number(id)}/licence-keys`, body, as),
  revokeKey: (keyId, as) => post(`/licence-keys/${Number(keyId)}/revoke`, {}, as),
  modules: (id, as) => get(`/offices/${Number(id)}/modules`, as),
  setModules: (id, modules, as) => put(`/offices/${Number(id)}/modules`, { modules }, as),
  catalogue: (as) => get('/modules', as),
  setModuleCatalogue: (key, body, as) => put(`/modules/${encodeURIComponent(key)}`, body, as),
  holds: (id, as) => get(`/offices/${Number(id)}/holds`, as),
  setHold: (id, item, body, as) => put(`/offices/${Number(id)}/holds/${encodeURIComponent(item)}`, body, as),
  setStatus: (id, status, reason, as) => post(`/offices/${Number(id)}/status`, { status, reason }, as),
  // Which version of each Windows app a venue runs (src/app_updates.js there).
  appVersions: (app, as) => get(`/app-versions?app=${encodeURIComponent(app)}`, as),
  setAppVersion: (app, body, as) => put(`/app-versions/${encodeURIComponent(app)}`, body, as),
  setAppUpdates: (enabled, as) => put('/app-versions-settings', { enabled: !!enabled }, as),
};
