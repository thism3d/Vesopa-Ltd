// Cancel the submission an app has in progress (in certification or
// waiting to publish), so a newer version can be sent in its place.
//
//   node examples/cancel-pending.js <app>
//
// The owner asked for this on 2026-10-09: "If any update in certification,
// cancel and update with the latest versions in stores." A submission that
// has already published cannot be cancelled and is left alone. If the
// Store refuses the cancel, it says so: Partner Center's own "Cancel
// submission" button on that submission does the same.
import "dotenv/config";
import { StoreSubmissionClient } from "../src/client.js";
import { resolveStoreId } from "../src/apps.config.js";

const [appArg] = process.argv.slice(2);
if (!appArg) {
  console.error("Usage: node examples/cancel-pending.js <app>");
  process.exit(1);
}
const storeId = resolveStoreId(appArg);
const client = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});
const app = await client.getApplication(storeId);
const pending = app.pendingApplicationSubmission;
if (!pending) {
  console.log(`${appArg}: nothing in progress`);
  process.exit(0);
}
const s = await client.getSubmission(storeId, pending.id);
console.log(`${appArg}: submission ${pending.id} is ${s.status}`);
try {
  await client.deleteSubmission(storeId, pending.id);
  console.log(`${appArg}: cancelled ${pending.id}`);
} catch (e) {
  console.error(`${appArg}: the Store would not cancel ${pending.id} (${e.message}). ` +
    "Cancel it in Partner Center: the app, its submission, Cancel submission.");
  process.exit(1);
}
