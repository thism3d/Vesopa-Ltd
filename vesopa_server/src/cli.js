#!/usr/bin/env node
// Minimal CLI over the StoreSubmissionClient, for quick manual use.
//
// Usage:
//   node src/cli.js list-apps
//   node src/cli.js get-app <app-name-or-store-id>
//   node src/cli.js create-submission <app-name-or-store-id>
//   node src/cli.js status <app-name-or-store-id> <submissionId>
//   node src/cli.js commit <app-name-or-store-id> <submissionId>
//   node src/cli.js delete-submission <app-name-or-store-id> <submissionId>
//
// app-name-or-store-id can be one of: vesopa-epos, vesopa-kitchen,
// vesopa-display, or a raw Store ID like 9PDMNJXNFZCW.

import "dotenv/config";
import { StoreSubmissionClient } from "./client.js";
import { resolveStoreId } from "./apps.config.js";

function creds() {
  return {
    tenantId: process.env.MS_STORE_TENANT_ID,
    clientId: process.env.MS_STORE_CLIENT_ID,
    clientSecret: process.env.MS_STORE_CLIENT_SECRET,
  };
}

async function main() {
  const [, , cmd, arg1, arg2] = process.argv;
  const client = new StoreSubmissionClient(creds());

  switch (cmd) {
    case "list-apps": {
      const apps = await client.listApplications();
      console.log(JSON.stringify(apps, null, 2));
      break;
    }
    case "get-app": {
      const storeId = resolveStoreId(arg1);
      console.log(JSON.stringify(await client.getApplication(storeId), null, 2));
      break;
    }
    case "create-submission": {
      const storeId = resolveStoreId(arg1);
      const submission = await client.createSubmission(storeId);
      console.log(JSON.stringify(submission, null, 2));
      break;
    }
    case "status": {
      const storeId = resolveStoreId(arg1);
      console.log(
        JSON.stringify(await client.getSubmissionStatus(storeId, arg2), null, 2)
      );
      break;
    }
    case "commit": {
      const storeId = resolveStoreId(arg1);
      console.log(
        JSON.stringify(await client.commitSubmission(storeId, arg2), null, 2)
      );
      break;
    }
    case "delete-submission": {
      const storeId = resolveStoreId(arg1);
      await client.deleteSubmission(storeId, arg2);
      console.log("Deleted.");
      break;
    }
    default:
      console.log(
        "Usage: node src/cli.js <list-apps|get-app|create-submission|status|commit|delete-submission> [app] [submissionId]"
      );
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.body ? JSON.stringify(err.body, null, 2) : err.message);
  process.exitCode = 1;
});
