// Commit a staged submission and watch what the Store does with it.
//
// THIS IS THE ONE THAT SHIPS. Committing tells Partner Center the submission
// is finished; the Store then unpacks the uploaded zip, validates the package
// and sends the submission to certification. From here on nothing is a draft.
//
// Run: node examples/commit-1670.js <app>
//
// WHAT IT CHECKS BEFORE COMMITTING
//
// The submission must be at PendingCommit with no errors, and it must declare
// exactly one package arriving. Both are worth checking because the failure
// they catch is invisible until it is expensive: a submission committed with
// nothing arriving replaces a live app's package list with an empty one.
//
// WHAT THE STATUSES MEAN (docs: manage-app-submissions)
//
//   CommitStarted     the Store has taken it
//   PreProcessing     the package is being unpacked and read
//   CommitFailed      the request was wrong; statusDetails says how
//   Certification     it is being reviewed
//   Published         it is live
//
// The first three settle in a minute or two; certification takes hours to
// days, so this stops watching once it reaches a state a person has to wait
// on rather than sitting on a socket for a day.
import "dotenv/config";
import { StoreSubmissionClient } from "../src/client.js";
import { resolveStoreId } from "../src/apps.config.js";

const [, , appArg] = process.argv;
if (!appArg) {
  console.error("Usage: node examples/commit-1670.js <app-name-or-store-id>");
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
  console.error(`${storeId} has no submission in progress.`);
  process.exit(1);
}

const submission = await client.getSubmission(storeId, pending.id);
console.log(`${storeId} submission ${pending.id}: ${submission.status}`);

if (submission.status !== "PendingCommit") {
  console.error(
    `Not committable from ${submission.status}. ` +
      JSON.stringify(submission.statusDetails?.errors ?? [])
  );
  process.exit(1);
}
const errors = submission.statusDetails?.errors ?? [];
if (errors.length) {
  console.error("The submission already has errors: " + JSON.stringify(errors));
  process.exit(1);
}

const packages = submission.applicationPackages ?? [];
const arriving = packages.filter((p) => p.fileStatus === "PendingUpload");
const leaving = packages.filter((p) => p.fileStatus === "PendingDelete");
if (arriving.length !== 1) {
  console.error(
    `Expected exactly one package arriving, found ${arriving.length}. ` +
      `Committing this would change which builds the app offers in a way ` +
      `nobody intended.`
  );
  process.exit(1);
}
console.log(`  arriving: ${arriving[0].fileName}`);
for (const p of leaving) console.log(`  leaving:  ${p.fileName} ${p.version}`);
console.log(`  publish:  ${submission.targetPublishMode}`);

const commit = await client.commitSubmission(storeId, pending.id);
console.log(`  committed — status now ${commit.status}`);

// Watch it through ingestion. Stops at the first state that is somebody
// else's turn: certification is measured in hours, and a script holding a
// connection open for that is a script nobody will run to the end.
const settled = new Set([
  "PendingCommit",
  "CommitFailed",
  "PreProcessingFailed",
  "Certification",
  "CertificationFailed",
  "PendingPublication",
  "Publishing",
  "Published",
  "PublishFailed",
  "Release",
  "ReleaseFailed",
  "Canceled",
]);

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 15_000));
  const status = await client.getSubmissionStatus(storeId, pending.id);
  console.log(`  ${new Date().toISOString().slice(11, 19)}  ${status.status}`);
  const problems = status.statusDetails?.errors ?? [];
  if (problems.length) {
    console.error("  errors: " + JSON.stringify(problems, null, 2));
  }
  const warnings = status.statusDetails?.warnings ?? [];
  for (const w of warnings) {
    // The sales-resource warning is on every submission this account makes and
    // means nothing here.
    if (w.code === "SalesUnsupportedWarning") continue;
    console.log(`  warning: ${w.code} — ${w.details}`);
  }
  if (settled.has(status.status)) {
    console.log(`\nDone watching at ${status.status}.`);
    process.exit(status.status.endsWith("Failed") ? 1 : 0);
  }
}
console.log("\nStill processing after ten minutes — check Partner Center.");
