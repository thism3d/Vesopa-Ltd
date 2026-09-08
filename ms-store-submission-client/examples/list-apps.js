// Example: list every app in the Partner Center account and show which
// ones match Vesopa EPOS / Vesopa Display / Vesopa Kitchen by Store ID.
import "dotenv/config";
import { StoreSubmissionClient } from "../src/client.js";
import { APPS } from "../src/apps.config.js";

const client = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});

const { value: apps } = await client.listApplications();

const knownIds = new Map(
  Object.values(APPS)
    .filter((a) => a.storeId)
    .map((a) => [a.storeId, a.label])
);

for (const app of apps) {
  const label = knownIds.get(app.id) ? ` (${knownIds.get(app.id)})` : "";
  console.log(`${app.id}${label} — ${app.primaryName}`);
}
