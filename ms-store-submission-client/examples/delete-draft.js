// Delete a DRAFT submission this client staged (never a committed one).
//
//   node examples/delete-draft.js <app> <submission-id>
//
// For replacing a staged package before it has been submitted: only one
// submission can be in progress per app, so the old draft has to go first.
import "dotenv/config";
import { StoreSubmissionClient } from "../src/client.js";
import { resolveStoreId } from "../src/apps.config.js";

const [appArg, submissionId] = process.argv.slice(2);
if (!appArg || !submissionId) {
  console.error("Usage: node examples/delete-draft.js <app> <submission-id>");
  process.exit(1);
}
const storeId = resolveStoreId(appArg);
const client = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});
const s = await client.getSubmission(storeId, submissionId);
if (s.status !== "PendingCommit") {
  console.error(`Submission ${submissionId} is ${s.status}; only an uncommitted draft is deleted here.`);
  process.exit(1);
}
await client.deleteSubmission(storeId, submissionId);
console.log(`deleted draft ${submissionId}`);
