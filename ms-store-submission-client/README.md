# Microsoft Store submission API client

A small, reusable Node.js client for the Microsoft Store submission API
(Partner Center), set up for **Vesopa EPOS**, **Vesopa Display**, and
**Vesopa Kitchen**. It wraps the REST calls to create/update/upload/commit
app submissions instead of doing everything by hand in Partner Center.

## Does this cost anything?

No. Confirmed against Microsoft's docs:

- The submission API itself is free to call — it's included with the
  Partner Center developer account you already have (the one-time
  developer account registration fee, which you've already paid since
  your apps are live).
- The Azure AD app registration needed to authenticate is free.
- Creating an Azure AD directory, if you don't already have one, is also
  free — Partner Center lets you create one at no charge.

The only thing that ever changes state in the real world is calling
`commitSubmission(...)`, which sends a submission to Microsoft's
certification pipeline. That's not a money cost, but it is a real action —
see "Safety notes" below.

## One-time setup (you need to do this yourself — it requires your own
Partner Center / Azure AD login)

1. **Azure AD directory.** If your Partner Center account isn't already
   linked to an Azure AD directory, create one (Partner Center prompts you
   for this, or see
   [Create a new Azure AD tenant](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/create-new-azure-ad-tenant)).
2. **Associate Azure AD with Partner Center**, if not already done: see
   [Associate your Partner Center account with Azure AD](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/associate-azure-ad-with-partner-center).
3. **Add an Azure AD application** from Partner Center: **Account
   settings > Users > Azure AD applications > Add Azure AD application**.
   See [Manage Azure AD applications in Partner Center](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/manage-azure-ad-applications-in-partner-center).
4. Assign that application the **Manager** role on your Partner Center
   account.
5. Copy the **Tenant ID** and **Client ID** shown for the app.
6. Generate a **Key** (client secret) for the app and copy it immediately
   — Partner Center only shows it once.
7. Copy `.env.example` to `.env` and fill in `MS_STORE_TENANT_ID`,
   `MS_STORE_CLIENT_ID`, `MS_STORE_CLIENT_SECRET`. Never commit `.env`
   (it's already in `.gitignore`).
8. Fill in `VESOPA_DISPLAY_STORE_ID` in `.env` once you have that app's
   Store ID from **Partner Center > App identity**. Vesopa EPOS
   (`9PDMNJXNFZCW`) and Vesopa Kitchen (`9P29NN3R5PGS`) are already filled
   in.

Note: the API can only manage submissions for apps that **already exist**
in Partner Center and already have at least one completed submission
(including the age ratings questionnaire) done manually. It can't create a
brand-new app from scratch — that first submission has to happen in the
Partner Center UI.

## Install

```bash
npm install
```

## Use it as a library

```js
import { StoreSubmissionClient } from "./src/client.js";
import { resolveStoreId } from "./src/apps.config.js";

const client = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});

const storeId = resolveStoreId("vesopa-kitchen"); // or "vesopa-epos" / "vesopa-display"

const apps = await client.listApplications();
const submission = await client.createSubmission(storeId);
// ...edit submission fields, then:
await client.updateSubmission(storeId, submission.id, submission);
await client.zipAndUploadFiles(submission.fileUploadUrl, ["./MyApp.appx"], "./out.zip");
await client.commitSubmission(storeId, submission.id);
const finalStatus = await client.waitForStatus(storeId, submission.id);
```

See `src/client.js` for the full method list: `listApplications`,
`getApplication`, `createSubmission`, `getSubmission`, `updateSubmission`,
`commitSubmission`, `getSubmissionStatus`, `deleteSubmission`,
`waitForStatus`, `zipAndUploadFiles`.

## Use the CLI

```bash
node src/cli.js list-apps
node src/cli.js get-app vesopa-epos
node src/cli.js create-submission vesopa-kitchen
node src/cli.js status vesopa-kitchen <submissionId>
node src/cli.js commit vesopa-kitchen <submissionId>
node src/cli.js delete-submission vesopa-kitchen <submissionId>
```

## Full example (create → upload → stop before commit)

```bash
node examples/create-submission.js vesopa-kitchen ./path/to/package.appx
```

This creates a real in-progress submission, uploads your package, and then
stops — the `commitSubmission` call is commented out so nothing ships to
Microsoft's certification queue until you uncomment it deliberately.

## Releasing a Vesopa version, end to end

This is the path that was actually used for 1.6.7.0, in order. Everything
before `commit.js` is reversible; that one is not.

```bash
# 0. Build the packages first. All three apps must have the same version in
#    pubspec.yaml (`version:` AND `msix_config.msix_version`), and the Store
#    refuses a version it has already accepted.
(cd ../vesopa_epos        && flutter build windows --release && dart run msix:create --store)
(cd ../vesopa_epos_kitchen && flutter build windows --release && dart run msix:create --store)
(cd ../vesopa_epos_display && flutter build windows --release && dart run msix:create --store)

# 1. Prove the credentials work. Read-only, changes nothing.
node src/cli.js list-apps

# 2. Stage: create the draft, attach the package, set the notes, upload.
STAGE_VERSION=1.6.8.0 node examples/stage.js vesopa-epos     ../vesopa_epos/build/store/vesopa-epos-store.msix notes-1.6.8.0-epos.txt

# 3. Fix the wording without re-uploading tens of megabytes, as often as needed.
node examples/set-notes.js vesopa-epos notes-1.6.8.0-epos.txt

# 4. Ship it. Unpacks, validates, and goes to certification.
node examples/commit.js vesopa-epos
```

Package paths differ per app, because the kitchen's msix config has no
`output_path`:

| App | Key | Store ID | Package |
|---|---|---|---|
| Vesopa EPOS | `vesopa-epos` | 9PDMNJXNFZCW | `vesopa_epos/build/store/vesopa-epos-store.msix` |
| Vesopa Kitchen | `vesopa-kitchen` | 9P29NN3R5PGS | `vesopa_epos_kitchen/build/windows/x64/runner/Release/vesopa_epos_kitchen.msix` |
| Vesopa Customer Display | `vesopa-display` | 9P8JCLQ5M3SQ | `vesopa_epos_display/build/store/vesopa-display-store.msix` |

### There is no "validated but not submitted" state

Say this out loud before starting, because Partner Center's UI implies
otherwise and it caused a whole round of confusion on 1.6.7.0.

Uploading a package puts a zip in blob storage and nothing else. **The Store
does not open that zip until the submission is committed**, and the same
commit carries the submission straight into certification. Until then Partner
Center shows *Packages: Unchanged* with the previous package still listed as
Validated, and the API shows the new one with no version, no languages and no
capabilities. None of that means the upload failed — check it by reading the
blob back, which `stage.js` does and prints.

If somebody wants to see a validated package and press **Submit** themselves,
the msix has to be dragged into Partner Center by hand. This API cannot offer
that; do not promise it.

Check `targetPublishMode` too. Vesopa's submissions are `Immediate`, so
anything that passes certification goes live to every venue with no second
gate.

### Release notes: the format

From 1.6.7.0 onwards, every Vesopa release note is:

```
Version 1.6.7.0 - Short title of the update

First paragraph, on ONE line however long it runs.

Second paragraph, also one line.
```

**One paragraph per line. Never hard-wrap.** Partner Center renders every
newline in this field as a real line break, so prose wrapped at 78 characters
— which is what it looks like drafted in a markdown fence — reaches the public
Store page broken mid-sentence on every line. `set-notes.js` refuses notes
that fail this check, because the mistake is invisible until it is published.

The kept copy of the wording lives in
`vesopa_epos/docs/store-listing-<version>.md`; the `notes-*.txt` files here are
generated from it and are gitignored.

### Two traps

1. **The new package must not share a file name with the one it replaces.**
   Replacing a package means listing the old one `PendingDelete` and the new
   one `PendingUpload` — and all three Vesopa msix files come out of the same
   config, so both entries had the same name. That is ambiguous to the Store
   and read as a submission with no package in it. `STAGE_VERSION` stamps the
   version into the name; `stage.js` refuses to stage if the name it is
   about to add is already in the submission.
2. **"The PUT did not throw" is not "the file is there."** The upload is a
   blind PUT to a SAS URL that returns no useful body. Read the blob back with
   a HEAD and compare byte counts.

## Safety notes

- **Don't mix API and Partner Center UI edits** on the same submission —
  Microsoft's own docs warn this can leave a submission in an error state.
  Once you create a submission via the API, keep editing it via the API
  until it's committed or deleted.
- `commitSubmission` is the only call that sends anything to Microsoft for
  real review/publishing. Everything before it (`createSubmission`,
  `updateSubmission`, uploading files) only edits a draft that lives in
  your Partner Center account and is safe to inspect there before
  committing.
- A single-shot blob upload (`zipAndUploadFiles`) supports files up to
  256 MB. If Vesopa EPOS/Display/Kitchen packages ever exceed that, switch
  to the `@azure/storage-blob` SDK's block-upload APIs against the same
  `fileUploadUrl`.

## Reference docs

- [Overview / prerequisites / auth](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [Manage app submissions (REST reference)](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions)
- [Get app data](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-app-data)
