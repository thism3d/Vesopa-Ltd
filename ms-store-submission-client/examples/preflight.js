/**
 * Is this app ready to submit?
 *
 *   node examples/preflight.js                 every app
 *   node examples/preflight.js vesopa-epos     one
 *
 * Everything that has to line up before a submission, checked in one place and
 * BEFORE anything is uploaded. A submission that fails half way leaves a draft
 * in Partner Center that has to be untangled by hand, so the cheap checks are
 * worth doing first:
 *
 *   * the package exists where the build puts it;
 *   * the version inside the package matches the pubspec -- read out of the
 *     packed AppxManifest, not from the config that was supposed to produce it;
 *   * the release notes exist, pass the format rules, and name the same version;
 *   * the Store is not already serving that version;
 *   * there is no submission already in progress, because there can only be one.
 *
 * Read-only. It submits nothing and uploads nothing.
 */
import "dotenv/config";

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { StoreSubmissionClient } from "../src/client.js";
import { APPS } from "../src/apps.config.js";
import { readReleaseNotes, versionInNotes } from "../src/release-notes.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

const APP_DIR = {
  "vesopa-epos": "vesopa_epos",
  "vesopa-kitchen": "vesopa_epos_kitchen",
  "vesopa-display": "vesopa_epos_display",
  "vesopa-express": "vesopa_express",
  "vesopa-loyalty": "vesopa_loyalty",
};

const NOTES_PREFIX = {
  "vesopa-epos": "epos",
  "vesopa-kitchen": "kitchen",
  "vesopa-display": "display",
  "vesopa-express": "express",
  "vesopa-loyalty": "loyalty",
};

function pubspecVersion(dir) {
  const text = readFileSync(join(repo, dir, "pubspec.yaml"), "utf8");
  return /^\s*msix_version:\s*(\S+)/m.exec(text)?.[1] ?? null;
}

function packagePath(dir) {
  const text = readFileSync(join(repo, dir, "pubspec.yaml"), "utf8");
  const out = /^\s*output_path:\s*(\S+)/m.exec(text)?.[1];
  const name = /^\s*output_name:\s*(\S+)/m.exec(text)?.[1];
  if (!out || !name) return null;
  return join(repo, dir, out, `${name}.msix`);
}

/**
 * The version Partner Center will read: the one inside the package.
 *
 * Unzipped with Python because it is already on this machine for the other
 * tools and pulling a zip library in for four reads is not worth it.
 */
function versionInPackage(msix) {
  try {
    const code =
      "import zipfile,re,sys;" +
      "z=zipfile.ZipFile(sys.argv[1]);" +
      "m=z.read('AppxManifest.xml').decode('utf-8','replace');" +
      "print(re.search(r'Version=\"([0-9.]+)\"',m).group(1))";
    return execFileSync("python", ["-c", code, msix], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const client = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});

const only = process.argv[2];
const names = only ? [only] : Object.keys(APPS);
let blocked = 0;

for (const name of names) {
  const dir = APP_DIR[name];
  const app = APPS[name];
  console.log(`\n${name} (${app.storeId})`);
  const problems = [];
  const ok = [];

  const wanted = pubspecVersion(dir);
  if (!wanted) problems.push("pubspec has no msix_version");
  else ok.push(`pubspec says ${wanted}`);

  const msix = packagePath(dir);
  if (!msix) {
    problems.push("pubspec sets no output_path/output_name, so the package cannot be found");
  } else if (!existsSync(msix)) {
    problems.push(`no package at ${msix.replace(repo, ".")} — run: dart run msix:create --store`);
  } else {
    const inside = versionInPackage(msix);
    if (!inside) problems.push("could not read the version out of the package");
    else if (inside !== wanted) {
      problems.push(`package is ${inside} but the pubspec says ${wanted} — rebuild it`);
    } else ok.push(`package is ${inside}`);
  }

  const notesFile = join(here, "..", `notes-${wanted}-${NOTES_PREFIX[name]}.txt`);
  if (!existsSync(notesFile)) {
    problems.push(`no release notes at notes-${wanted}-${NOTES_PREFIX[name]}.txt`);
  } else {
    try {
      const text = readReleaseNotes(notesFile);
      const v = versionInNotes(text);
      if (v !== wanted) problems.push(`the notes say ${v}, the package says ${wanted}`);
      else ok.push(`notes valid, ${text.length} chars`);
    } catch (e) {
      problems.push(`notes: ${e.message}`);
    }
  }

  try {
    const detail = await client.getApplication(app.storeId);
    const pending = detail.pendingApplicationSubmission;
    if (pending) {
      problems.push(
        `a submission is already in progress (${pending.id}) — publish or delete it first, ` +
          "an app can only have one"
      );
    } else ok.push("no submission in progress");

    const publishedId = detail.lastPublishedApplicationSubmission?.id;
    if (publishedId) {
      const sub = await client.getSubmission(app.storeId, publishedId);
      const live = (sub.applicationPackages || []).map((p) => p.version);
      if (live.includes(wanted)) {
        problems.push(`${wanted} is already published — the Store refuses a version twice`);
      } else ok.push(`Store is serving ${live.join(", ") || "nothing"}`);
    }
  } catch (e) {
    problems.push(`Store: ${e.message}`);
  }

  for (const line of ok) console.log(`  ok    ${line}`);
  for (const line of problems) console.log(`  BLOCK ${line}`);
  if (problems.length) blocked += 1;
  else console.log("  -> ready to submit");
}

console.log(
  `\n${names.length - blocked} of ${names.length} ready, ${blocked} blocked.\n`
);
process.exitCode = blocked ? 1 : 0;
