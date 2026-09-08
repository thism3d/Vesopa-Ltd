// Stage the 1.6.7.0 submission for one app: package + release notes, no commit.
//
// WHAT THIS DOES AND DOES NOT DO
//
// It creates an in-progress submission (a copy of the last published one),
// points it at the new package, marks the superseded ones for deletion, sets
// the release notes, and uploads. It NEVER calls commitSubmission — that is
// the one call that puts an update in front of Microsoft's certification
// pipeline, and it is the venue's to make. Everything here lives as a draft
// in Partner Center and can be reviewed, edited or deleted there.
//
// Run: node examples/stage-1670.js <app> <package> <release-notes-file>
//
// The release notes come from a file rather than the command line because
// they are multi-paragraph prose and every shell on this machine mangles at
// least one character of it.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { StoreSubmissionClient } from "../src/client.js";
import { resolveStoreId } from "../src/apps.config.js";

const [, , appArg, packageArg, notesArg] = process.argv;
if (!appArg || !packageArg || !notesArg) {
  console.error(
    "Usage: node examples/stage-1670.js <app> <package.msix> <notes.txt>"
  );
  process.exit(1);
}

const notes = fs.readFileSync(notesArg, "utf8").trim();
if (!notes) {
  console.error("The release notes file is empty.");
  process.exit(1);
}
if (notes.length > 1500) {
  console.error(`Release notes are ${notes.length} characters; the limit is 1500.`);
  process.exit(1);
}
if (!fs.existsSync(packageArg)) {
  console.error(`No package at ${packageArg}`);
  process.exit(1);
}

const storeId = resolveStoreId(appArg);
const client = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});

// Refuse to start a second one. Microsoft's own docs warn that mixing API and
// UI edits, or leaving two drafts about, leaves a submission in an error state
// that has to be untangled by hand.
const app = await client.getApplication(storeId);
if (app.pendingApplicationSubmission) {
  console.error(
    `${storeId} already has a submission in progress ` +
      `(${app.pendingApplicationSubmission.id}). Delete or commit it in ` +
      `Partner Center before staging another.`
  );
  process.exit(2);
}

const submission = await client.createSubmission(storeId);
console.log(`Created draft submission ${submission.id} for ${storeId}`);

// The name the package is uploaded under, stamped with its version.
//
// NOT the plain basename. A submission that replaces a package lists the old
// one as PendingDelete and the new one as PendingUpload — and both of ours
// are produced by the same msix config, so both had the SAME file name. Two
// entries with one name, one being deleted and one arriving, is ambiguous to
// the Store and it showed as a submission with no package in it. The version
// is in the name now, so the two entries can never collide again.
const version = process.env.STAGE_VERSION || "";
const base = path.basename(packageArg, path.extname(packageArg));
const ext = path.extname(packageArg);
const fileName = version ? `${base}-${version}${ext}` : path.basename(packageArg);

// The new package goes on; the ones it replaces come off. Same identity, same
// architecture, higher version — leaving the old one would put two builds in
// one submission for no reason.
const keep = (submission.applicationPackages ?? []).filter(
  (p) => p.fileStatus !== "PendingDelete"
);
if (keep.some((p) => p.fileName === fileName)) {
  console.error(
    `The package already in this submission is also called ${fileName}. ` +
      `Bump the version or change the name — two entries under one name is ` +
      `what produced an empty submission last time.`
  );
  await client.deleteSubmission(storeId, submission.id);
  process.exit(1);
}
submission.applicationPackages = [
  ...keep.map((p) => ({ ...p, fileStatus: "PendingDelete" })),
  { fileName, fileStatus: "PendingUpload" },
];
console.log(
  `  ${keep.length} existing package(s) marked for deletion, adding ${fileName}`
);

// The release notes, on every listing the app has. Set rather than appended:
// these describe THIS version, and last release's notes underneath them would
// read as a list of things that are all new.
let listings = 0;
for (const [lang, listing] of Object.entries(submission.listings ?? {})) {
  if (!listing.baseListing) continue;
  listing.baseListing.releaseNotes = notes;
  listings++;
  console.log(`  release notes set on ${lang} (${notes.length} characters)`);
}
if (listings === 0) {
  console.error("No listing to put release notes on — stopping before upload.");
  await client.deleteSubmission(storeId, submission.id);
  process.exit(1);
}

await client.updateSubmission(storeId, submission.id, submission);

const zipPath = path.resolve(`./${storeId}-${submission.id}.zip`);
await client.zipAndUploadFiles(
  submission.fileUploadUrl,
  [{ path: packageArg, nameInZip: fileName }],
  zipPath
);
const zipped = fs.statSync(zipPath).size;
fs.rmSync(zipPath, { force: true });

// Read the blob back. The upload is a PUT to a URL nobody sees the result of,
// and "it did not throw" is not the same as "it is there" — the whole reason
// this step is being done a second time is that nothing here proved it.
let blob = "could not be checked";
try {
  const head = await fetch(submission.fileUploadUrl, { method: "HEAD" });
  const size = Number(head.headers.get("content-length") ?? 0);
  blob = `${head.status} ${head.statusText}, ${size} bytes`;
  if (!head.ok || size !== zipped) {
    console.error(`Uploaded ${zipped} bytes but the blob reads back as ${blob}.`);
    process.exit(1);
  }
} catch (e) {
  console.error(`Could not read the upload back: ${e.message}`);
  process.exit(1);
}
console.log(`Uploaded ${fileName} (${zipped} bytes zipped); blob reads ${blob}`);

const after = await client.getSubmission(storeId, submission.id);
console.log(
  `\nStaged, NOT committed.\n` +
    `  app        ${storeId}\n` +
    `  submission ${submission.id}\n` +
    `  status     ${after.status}\n` +
    `  packages   ${(after.applicationPackages ?? [])
      .map((p) => `${p.fileName} [${p.fileStatus}] ${p.version ?? ""}`)
      .join(", ")}\n` +
    `Review it in Partner Center and press Submit there when you are ready.`
);
