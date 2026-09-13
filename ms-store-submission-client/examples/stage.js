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
// Run: node examples/stage.js <app> <package> <release-notes-file>
//
// The release notes come from a file rather than the command line because
// they are multi-paragraph prose and every shell on this machine mangles at
// least one character of it.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { StoreSubmissionClient } from "../src/client.js";
import { resolveStoreId } from "../src/apps.config.js";
import { readReleaseNotes, versionInNotes } from "../src/release-notes.js";

// `--flight <id>` stages to a package flight instead of the public listing: the
// same build, certified the same way, but it reaches only the testers in that
// flight's group. That is the difference between "held back until we publish"
// (which Manual already gives us) and "our testers have it and nobody else
// can", which is what testing on a real till actually needs.
const rawArgs = process.argv.slice(2);
let flightId = null;
const flightAt = rawArgs.indexOf("--flight");
if (flightAt !== -1) {
  flightId = rawArgs[flightAt + 1];
  if (!flightId) {
    console.error("--flight needs a flight id. `node examples/flights.js <app>` lists them.");
    process.exit(1);
  }
  rawArgs.splice(flightAt, 2);
}

const [appArg, packageArg, notesArg] = rawArgs;
if (!appArg || !packageArg || !notesArg) {
  console.error(
    "Usage: node examples/stage.js <app> <package.msix> <notes.txt> [--flight <id>]"
  );
  process.exit(1);
}

// The venue's shape, checked here as well as in set-notes.js — this is the
// path notes normally arrive by, and it was the one that did not look.
let notes;
try {
  notes = readReleaseNotes(notesArg);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (!fs.existsSync(packageArg)) {
  console.error(`No package at ${packageArg}`);
  process.exit(1);
}

// The words and the binary are set in different files, and shipping one
// release's notes over another's package is a mistake nothing else here would
// catch.
const declared = versionInNotes(notes);
if (process.env.STAGE_VERSION && declared !== process.env.STAGE_VERSION) {
  console.error(
    `The notes say ${declared} and STAGE_VERSION says ` +
      `${process.env.STAGE_VERSION}. One of them is wrong.`
  );
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
const where = flightId ? `flight ${flightId}` : storeId;

// A flight keeps its pending submission on the flight, not on the app, so the
// two are asked separately -- and an app-level draft does not block a flight.
const pending = flightId
  ? (await client.getFlight(storeId, flightId)).pendingFlightSubmission
  : app.pendingApplicationSubmission;
if (pending) {
  console.error(
    `${where} already has a submission in progress ` +
      `(${pending.id}). Delete or commit it in ` +
      `Partner Center before staging another.`
  );
  process.exit(2);
}

const submission = flightId
  ? await client.createFlightSubmission(storeId, flightId)
  : await client.createSubmission(storeId);
console.log(`Created draft submission ${submission.id} for ${where}`);

// NOTHING IS PUBLISHED UNTIL SOMEBODY SAYS SO.
//
// "Can we stop the tills from automatically updating? Updates should require
// manual approval, so we can test first and then release to customers."
//
// Manual publishing is that approval. Microsoft certifies the release and then
// it waits -- no till downloads anything -- until somebody presses "Publish
// now" in Partner Center, after testing it on the office till. Every Vesopa
// submission used to be Immediate, which put a certified build on every till
// the moment Microsoft passed it. PUBLISH_MODE=Immediate is still there for a
// fix that must go out the moment it is certified.
//
// A FLIGHT IS THE EXCEPTION. Manual on a flight would mean somebody had to
// press Publish for the testers as well, which is friction with no benefit --
// a flight only ever reaches the tester group, never a customer. So a flight
// publishes as soon as it is certified, and the main submission still waits.
const mode = flightId
  ? 'Immediate'
  : process.env.PUBLISH_MODE === 'Immediate'
    ? 'Immediate'
    : 'Manual';
submission.targetPublishMode = mode;
console.log(`  publish mode: ${mode}${mode === 'Manual' ? ' (waits for "Publish now" after certification)' : flightId ? ' (reaches the testers as soon as it is certified)' : ''}`);

// The name the package is uploaded under, stamped with its version.
//
// NOT the plain basename. A submission that replaces a package lists the old
// one as PendingDelete and the new one as PendingUpload — and both of ours
// are produced by the same msix config, so both had the SAME file name. Two
// entries with one name, one being deleted and one arriving, is ambiguous to
// the Store and it showed as a submission with no package in it. The version
// is in the name now, so the two entries can never collide again.
/*
 * The version that goes in the uploaded FILENAME.
 *
 * It used to come only from STAGE_VERSION, so forgetting to set it uploaded
 * the package under its bare name -- and the next release then collided with
 * it, because a submission cannot hold two packages called the same thing.
 * The guard below caught that, which is the right outcome, but the operator
 * was being asked to remember a number the tool already knows.
 *
 * It knows it because `declared` is read out of the release notes above and
 * checked against the package itself. So that is the default, and
 * STAGE_VERSION stays as an override for anybody who needs a different name.
 */
const version = process.env.STAGE_VERSION || declared || "";
const base = path.basename(packageArg, path.extname(packageArg));
const ext = path.extname(packageArg);
const fileName = version ? `${base}-${version}${ext}` : path.basename(packageArg);

// The new package goes on; the ones it replaces come off. Same identity, same
// architecture, higher version — leaving the old one would put two builds in
// one submission for no reason.
// A flight submission keeps its packages in `flightPackages`; the main one
// uses `applicationPackages`. Same shape, different name, and writing to the
// wrong one is silent -- the submission commits with no package in it.
const packagesField = flightId ? "flightPackages" : "applicationPackages";

const keep = (submission[packagesField] ?? []).filter(
  (p) => p.fileStatus !== "PendingDelete"
);
if (keep.some((p) => p.fileName === fileName)) {
  console.error(
    `The package already in this submission is also called ${fileName}. ` +
      `Bump the version or change the name — two entries under one name is ` +
      `what produced an empty submission last time.`
  );
  await (flightId
    ? client.deleteFlightSubmission(storeId, flightId, submission.id)
    : client.deleteSubmission(storeId, submission.id));
  process.exit(1);
}
submission[packagesField] = [
  ...keep.map((p) => ({ ...p, fileStatus: "PendingDelete" })),
  { fileName, fileStatus: "PendingUpload" },
];
console.log(
  `  ${keep.length} existing package(s) marked for deletion, adding ${fileName}`
);

// The release notes, on every listing the app has. Set rather than appended:
// these describe THIS version, and last release's notes underneath them would
// read as a list of things that are all new.
// A FLIGHT HAS NO LISTING. It is a private release to a tester group and
// never appears on the Store, so there is no page for release notes to go on
// -- the notes travel with the main submission that follows. They are still
// read and validated above, because the version in them is checked against
// the package, and that check is worth having either way.
if (flightId) {
  console.log("  no listing on a flight — the notes go with the main submission");
} else {
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
}

await (flightId
  ? client.updateFlightSubmission(storeId, flightId, submission.id, submission)
  : client.updateSubmission(storeId, submission.id, submission));

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
    `  packages   ${(after[packagesField] ?? [])
      .map((p) => `${p.fileName} [${p.fileStatus}] ${p.version ?? ""}`)
      .join(", ")}\n` +
    `Review it in Partner Center and press Submit there when you are ready.`
);
