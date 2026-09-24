// Replace the release notes on a submission that is already staged.
//
// Separate from stage.js because the package and the words are edited on
// different clocks: a package is rebuilt, but wording gets read back, argued
// with and changed several times before anybody commits. Re-staging the whole
// submission to fix a sentence would mean re-uploading tens of megabytes and
// throwing away a verified upload.
//
// Run: node examples/set-notes.js <app> <notes.txt>
//
// THE FORMAT, which is the venue's and applies to every release from 1.6.7.0
// on:
//
//     Version 1.6.7.0 - Short title
//     <blank line>
//     One paragraph per line, blank line between paragraphs.
//
// ONE PARAGRAPH PER LINE, not wrapped. Partner Center renders every newline
// in this field as a real line break, so prose hard-wrapped at 78 characters
// — which is what a file of it looks like in an editor — arrives on the Store
// page broken at 78 characters. This script refuses anything that looks
// wrapped, because the mistake is invisible until it is public.
import "dotenv/config";
import { StoreSubmissionClient } from "../src/client.js";
import { resolveStoreId } from "../src/apps.config.js";
import { readReleaseNotes } from "../src/release-notes.js";

const [, , appArg, notesArg] = process.argv;
if (!appArg || !notesArg) {
  console.error("Usage: node examples/set-notes.js <app> <notes.txt>");
  process.exit(1);
}

// The rules live in src/release-notes.js so that the staging script — the
// path notes normally arrive by, and the one that did not look — checks
// exactly the same things this one does.
let notes;
try {
  notes = readReleaseNotes(notesArg);
} catch (e) {
  console.error(e.message);
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
if (submission.status !== "PendingCommit") {
  console.error(
    `${storeId} is at ${submission.status}; the notes can only be changed ` +
      `before it is committed.`
  );
  process.exit(1);
}

let changed = 0;
for (const [lang, listing] of Object.entries(submission.listings ?? {})) {
  if (!listing.baseListing) continue;
  listing.baseListing.releaseNotes = notes;
  changed++;
  console.log(`  ${lang}: ${notes.length} characters, ${lines.length} lines`);
}
if (!changed) {
  console.error("No listing to write to.");
  process.exit(1);
}

await client.updateSubmission(storeId, pending.id, submission);

// Read it back. The whole reason this is being done again is that nothing
// checked what actually landed.
const after = await client.getSubmission(storeId, pending.id);
const lang = Object.keys(after.listings ?? {})[0];
const stored = after.listings[lang].baseListing.releaseNotes ?? "";
if (stored !== notes) {
  console.error(
    `Stored notes differ from what was sent (${stored.length} vs ${notes.length} chars).`
  );
  process.exit(1);
}
console.log(`Stored and verified on ${storeId} submission ${pending.id}.`);
console.log(`First line: ${stored.split("\n")[0]}`);
