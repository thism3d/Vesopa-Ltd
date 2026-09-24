// Set the certification notes on a submission that is still a draft.
//
//   node examples/set-cert-notes.js <app> <submission-id> <notes.txt>
//
// Notes for certification are what the Microsoft reviewer reads before opening
// the app: how to sign in, and what not to press. A submission created through
// the API does not always carry the last one's notes across (1.0.4.0 of the
// loyalty app arrived with none), and a reviewer who cannot sign in fails the
// app. Read from a file for the same reason release notes are.
import "dotenv/config";
import fs from "node:fs";
import { StoreSubmissionClient } from "../src/client.js";
import { resolveStoreId } from "../src/apps.config.js";

const [appArg, submissionId, notesFile] = process.argv.slice(2);
if (!appArg || !submissionId || !notesFile) {
  console.error("Usage: node examples/set-cert-notes.js <app> <submission-id> <notes.txt>");
  process.exit(1);
}
const notes = fs.readFileSync(notesFile, "utf8").replace(/\r\n/g, "\n").trim();
if (notes.length > 2000) {
  console.error(`Notes are ${notes.length} characters; the Store allows 2000.`);
  process.exit(1);
}
const storeId = resolveStoreId(appArg);
const client = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});
const submission = await client.getSubmission(storeId, submissionId);
if (submission.status !== "PendingCommit") {
  console.error(`Submission ${submissionId} is ${submission.status}; only a draft can be changed.`);
  process.exit(1);
}
submission.notesForCertification = notes;
await client.updateSubmission(storeId, submissionId, submission);
const after = await client.getSubmission(storeId, submissionId);
console.log(`certification notes set: ${(after.notesForCertification || "").length} characters on ${submissionId}`);
