// Example: full create -> update -> upload -> commit -> poll flow for one
// app. This is the ONLY script in this project that actually changes
// something in Partner Center (it creates a real in-progress submission
// and, if you call commitSubmission, sends it for certification/publishing).
//
// Run with: node examples/create-submission.js vesopa-kitchen ./package.appx
//
// Review each step before wiring this into anything automatic — it never
// costs money to call, but a commit does put a real update in front of
// Microsoft's certification pipeline and, once approved, live in the Store.

import "dotenv/config";
import path from "node:path";
import { StoreSubmissionClient } from "../src/client.js";
import { resolveStoreId } from "../src/apps.config.js";

const [, , appArg, packagePathArg] = process.argv;
if (!appArg || !packagePathArg) {
  console.error(
    "Usage: node examples/create-submission.js <app-name-or-store-id> <path-to-appx>"
  );
  process.exit(1);
}

const storeId = resolveStoreId(appArg);
const client = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});

// 1. Create a new in-progress submission (copy of the last published one).
const submission = await client.createSubmission(storeId);
console.log(`Created submission ${submission.id} for ${storeId}`);

// 2. Point the submission at the new package file name.
const packageFileName = path.basename(packagePathArg);
submission.applicationPackages = [
  ...(submission.applicationPackages ?? []).filter(
    (p) => p.fileStatus !== "PendingDelete"
  ),
  { fileName: packageFileName, fileStatus: "PendingUpload" },
];

// 3. Push the updated submission data.
await client.updateSubmission(storeId, submission.id, submission);

// 4. Zip the package and upload it to the submission's SAS URL.
const zipPath = path.resolve(`./${storeId}-${submission.id}.zip`);
await client.zipAndUploadFiles(
  submission.fileUploadUrl,
  [{ path: packagePathArg, nameInZip: packageFileName }],
  zipPath
);
console.log(`Uploaded ${packageFileName} via ${zipPath}`);

// 5. Commit — UNCOMMENT when you're ready to actually send this to
//    certification. Left commented out so running this example never
//    ships anything by accident.
//
// await client.commitSubmission(storeId, submission.id);
// const finalStatus = await client.waitForStatus(storeId, submission.id);
// console.log("Final status:", finalStatus.status);

console.log(
  "Submission is staged but NOT committed. Review it in Partner Center, " +
    "then call client.commitSubmission(...) when ready."
);
