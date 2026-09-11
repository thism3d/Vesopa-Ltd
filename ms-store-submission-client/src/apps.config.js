// Central place to name the apps this client manages, mapped to their
// public Microsoft Store IDs (Partner Center > App identity > Store ID).
// This is the same ID used as {applicationId} in the submission API.

export const APPS = {
  "vesopa-epos": {
    label: "Vesopa EPOS",
    storeId: process.env.VESOPA_EPOS_STORE_ID || "9PDMNJXNFZCW",
  },
  "vesopa-kitchen": {
    label: "Vesopa Kitchen",
    storeId: process.env.VESOPA_KITCHEN_STORE_ID || "9P29NN3R5PGS",
  },
  "vesopa-display": {
    label: "Vesopa Display",
    // Read off GET /v1.0/my/applications on 2026-09-08, which is the
    // authoritative source for this — it is the same value Partner Center
    // shows under App identity > Store ID.
    storeId: process.env.VESOPA_DISPLAY_STORE_ID || "9P8JCLQ5M3SQ",
  },
  "vesopa-express": {
    label: "Vesopa Express",
    // Reserved in Partner Center on 2026-09-11 (package family
    // MeirionDavies.VesopaExpress_nyzwpk2n60a5j).
    storeId: process.env.VESOPA_EXPRESS_STORE_ID || "9N5W5VLP2948",
  },
};

export function resolveStoreId(nameOrId) {
  const app = APPS[nameOrId];
  if (app) {
    if (!app.storeId) {
      throw new Error(
        `${app.label} has no Store ID configured yet. Set it in .env.`
      );
    }
    return app.storeId;
  }
  // Allow passing a raw Store ID directly (e.g. "9PDMNJXNFZCW")
  return nameOrId;
}
