// Fill in a submission's Store listing from a kept JSON file.
//
//     node examples/set-listing.js vesopa-loyalty listings/loyalty-1.0.0.0.json
//
// WHY THIS EXISTS, AND WHAT IT CANNOT DO
//
// A new app's first submission is created by Partner Center when the name is
// reserved. Until a package is uploaded, that submission refuses a PUT — which
// is what made Express's first release a typing job. Once somebody has uploaded
// and validated a package, the PUT is accepted and the WORDS can be written
// from here.
//
// The PICTURES still cannot. Images reach a submission inside a zip PUT to
// `fileUploadUrl`, and only a submission the API created has one; a Partner
// Center draft never does. So screenshots and logos are uploaded by hand, and
// this prints exactly which file goes where when it is done.
//
// It reads the same kept listing file the release is described in, so the words
// on the Store and the words in the repository cannot drift.
import "dotenv/config";
import fs from "node:fs";
import { StoreSubmissionClient } from "../src/client.js";
import { resolveStoreId } from "../src/apps.config.js";

const [, , appKey, listingFile] = process.argv;
if (!appKey || !listingFile) {
  console.error("Usage: node examples/set-listing.js <app> <listing.json>");
  process.exit(1);
}

const kept = JSON.parse(fs.readFileSync(listingFile, "utf8"));
const storeId = resolveStoreId(appKey);
const client = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});

const app = await client.getApplication(storeId);
const pending = app.pendingApplicationSubmission?.id;
if (!pending) {
  console.error("There is no submission in progress for this app.");
  process.exit(1);
}

const submission = await client.getSubmission(storeId, pending);
console.log(`${appKey} (${storeId}) submission ${pending} — ${submission.status}`);

// The Store's own limits, checked here rather than discovered in a 400.
const listing = kept.listing;
const problems = [];
if (!listing.description) problems.push("description is empty");
if ((listing.description || "").length > 10000) problems.push("description is over 10,000 characters");
if ((listing.features || []).length > 20) problems.push("more than 20 features");
if ((listing.keywords || []).length > 7) problems.push("more than 7 search terms");
for (const k of listing.keywords || []) {
  if (k.length > 45) problems.push(`search term over 45 characters: ${k}`);
}
if (problems.length) {
  console.error("Refusing:\n  " + problems.join("\n  "));
  process.exit(1);
}

/*
 * The language key the API uses is whatever is already there. Partner Center
 * created "en-gb"; inventing "en-GB" beside it would make a second listing and
 * the Store would ask for both to be filled in.
 */
const language = Object.keys(submission.listings || {})[0] || "en-gb";
const base = submission.listings?.[language]?.baseListing ?? {};

submission.listings = {
  ...submission.listings,
  [language]: {
    ...submission.listings?.[language],
    baseListing: {
      ...base,
      description: listing.description,
      features: listing.features ?? [],
      keywords: listing.keywords ?? [],
      releaseNotes: listing.releaseNotes ?? "",
      copyrightAndTrademarkInfo: listing.copyrightAndTrademarkInfo ?? "",
      privacyPolicy: listing.privacyPolicyUrl ?? base.privacyPolicy ?? "",
      supportContact: listing.supportContact ?? base.supportContact ?? "",
      websiteUrl: listing.websiteUrl ?? base.websiteUrl ?? "",
      title: listing.title ?? base.title,
      // Left exactly as found: images are not ours to write (see the note at
      // the top), and sending an empty array would delete any already added.
      images: base.images ?? [],
    },
  },
};

if (kept.submission?.notesForCertification) {
  submission.notesForCertification = kept.submission.notesForCertification;
}
if (kept.submission?.targetPublishMode) {
  submission.targetPublishMode = kept.submission.targetPublishMode;
}
if (kept.submission?.applicationCategory) {
  submission.applicationCategory = kept.submission.applicationCategory;
}

await client.updateSubmission(storeId, pending, submission);
console.log("listing written.");

const after = await client.getSubmission(storeId, pending);
const written = after.listings?.[language]?.baseListing ?? {};
console.log(`  description   ${written.description?.length ?? 0} characters`);
console.log(`  features      ${(written.features ?? []).length}`);
console.log(`  search terms  ${(written.keywords ?? []).length}`);
console.log(`  release notes ${written.releaseNotes?.length ?? 0} characters`);
console.log(`  images        ${(written.images ?? []).length}`);
console.log(`  publish mode  ${after.targetPublishMode}`);

const errors = after.statusDetails?.errors ?? [];
if (errors.length) {
  console.log("\nstill outstanding:");
  for (const e of errors) console.log("  -", e.details || e.code);
} else {
  console.log("\nnothing outstanding.");
}
