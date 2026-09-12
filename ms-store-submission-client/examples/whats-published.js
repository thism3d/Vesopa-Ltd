/**
 * What the Store is actually serving, against what the code says.
 *
 *   node examples/whats-published.js
 *
 * "Check the last updates versus the code changes in the Microsoft Store."
 *
 * The version in a pubspec is what the next build WOULD be. The version in the
 * Store is what a till actually downloads. They drift — a bump gets committed
 * and the submission never happens, or a submission is sitting in certification
 * and nobody remembers — and the gap is invisible until a venue reports a bug
 * that was fixed a month ago.
 *
 * Read-only. It submits nothing.
 */
import "dotenv/config";

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { StoreSubmissionClient } from "../src/client.js";
import { APPS } from "../src/apps.config.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

/** Where each app's pubspec lives, by the name apps.config.js uses. */
const PUBSPEC = {
  "vesopa-epos": "vesopa_epos/pubspec.yaml",
  "vesopa-kitchen": "vesopa_epos_kitchen/pubspec.yaml",
  "vesopa-display": "vesopa_epos_display/pubspec.yaml",
  "vesopa-express": "vesopa_express/pubspec.yaml",
};

function localVersion(name) {
  const path = PUBSPEC[name];
  if (!path) return null;
  try {
    const text = readFileSync(join(repo, path), "utf8");
    const msix = /^\s*msix_version:\s*(\S+)/m.exec(text);
    return msix ? msix[1] : null;
  } catch {
    return null;
  }
}

/** The highest package version in a submission, which is what a till gets. */
function versionOf(submission) {
  const packages = submission?.applicationPackages || [];
  const versions = packages.map((p) => p.version).filter(Boolean);
  if (!versions.length) return null;
  return versions.sort((a, b) => {
    const A = a.split(".").map(Number);
    const B = b.split(".").map(Number);
    for (let i = 0; i < 4; i += 1) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
    return 0;
  })[versions.length - 1];
}

const client = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});

const rows = [];

for (const [name, app] of Object.entries(APPS)) {
  const row = { name, storeId: app.storeId, local: localVersion(name) };
  try {
    const detail = await client.getApplication(app.storeId);
    row.title = detail.primaryName || name;

    const publishedId = detail.lastPublishedApplicationSubmission?.id;
    if (publishedId) {
      const sub = await client.getSubmission(app.storeId, publishedId);
      row.published = versionOf(sub);
      row.publishMode = sub.targetPublishMode;
    }

    const pendingId = detail.pendingApplicationSubmission?.id;
    if (pendingId) {
      row.pending = pendingId;
      try {
        const status = await client.getSubmissionStatus(app.storeId, pendingId);
        row.pendingStatus = status.status;
      } catch {
        row.pendingStatus = "unknown";
      }
    }

    try {
      const flights = await client.listFlights(app.storeId);
      row.flights = (flights.value || []).map((f) => ({
        id: f.flightId,
        name: f.friendlyName,
        pending: f.pendingFlightSubmission?.id || null,
      }));
    } catch (e) {
      row.flightError = e.message;
    }
  } catch (e) {
    row.error = e.message;
  }
  rows.push(row);
}

const pad = (s, n) => String(s ?? "—").padEnd(n);
console.log(
  `\n${pad("App", 18)}${pad("in the Store", 14)}${pad("in the code", 13)}${pad("state", 12)}`
);
console.log("-".repeat(60));

for (const r of rows) {
  if (r.error) {
    console.log(`${pad(r.title || r.name, 18)}ERROR: ${r.error}`);
    continue;
  }
  const changed = r.local && r.published && r.local !== r.published;
  const state = r.pending
    ? `submission in progress (${r.pendingStatus})`
    : changed
      ? "CODE IS AHEAD"
      : r.local === r.published
        ? "up to date"
        : "unknown";
  console.log(`${pad(r.title || r.name, 18)}${pad(r.published, 14)}${pad(r.local, 13)}${state}`);
}

console.log("\nFlights");
for (const r of rows) {
  if (r.flightError) {
    console.log(`  ${r.title || r.name}: could not be read — ${r.flightError}`);
    continue;
  }
  if (!r.flights?.length) {
    console.log(`  ${r.title || r.name}: none`);
    continue;
  }
  for (const f of r.flights) {
    console.log(
      `  ${r.title || r.name}: ${f.name} (${f.id})${f.pending ? " — submission in progress" : ""}`
    );
  }
}
console.log("");
