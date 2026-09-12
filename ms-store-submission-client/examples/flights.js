/**
 * Package flights: private releases to named testers.
 *
 *   node examples/flights.js <app>                       list an app's flights
 *   node examples/flights.js <app> --create "<name>" <groupId>[,<groupId>...]
 *   node examples/flights.js <app> --delete <flightId>
 *
 * WHY THIS EXISTS
 *
 * "Can we stop the tills from automatically updating? We want to test a version
 * before customers get it."
 *
 * Manual publish (see stage.js) answers half of that: a certified release waits
 * until somebody presses Publish now. But the moment it is published it goes to
 * every till at once, so the only thing that has been tested by then is a build
 * nobody has run on a real machine from the Store.
 *
 * A flight is the other half. It is a real Store release -- same packaging, same
 * certification, same update mechanism -- that reaches only the accounts in its
 * flight group. Put the office till in that group and it updates itself to the
 * new version while every customer stays where they are.
 *
 * The release path:
 *
 *   1. stage + commit to the flight      --flight <id>
 *   2. the office till updates itself; use it for a day
 *   3. stage + commit to the main submission, Manual
 *   4. Publish now, when you are happy
 *
 * THE GROUPS CANNOT BE MADE HERE. Partner Center owns flight groups (who is in
 * them is a list of Microsoft accounts), and the submission API has no endpoint
 * for creating one. Make "Vesopa Testers" once in Partner Center, take its id
 * from the URL, and pass it to --create.
 */
import "dotenv/config";

import { StoreSubmissionClient } from "../src/client.js";
import { resolveStoreId } from "../src/apps.config.js";

const args = process.argv.slice(2);
const appArg = args[0];
if (!appArg || appArg.startsWith("--")) {
  console.error(
    "Usage:\n" +
      "  node examples/flights.js <app>\n" +
      '  node examples/flights.js <app> --create "<friendly name>" <groupId>[,<groupId>]\n' +
      "  node examples/flights.js <app> --delete <flightId>"
  );
  process.exit(1);
}

const storeId = resolveStoreId(appArg);
const client = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});

const createAt = args.indexOf("--create");
const deleteAt = args.indexOf("--delete");

if (createAt !== -1) {
  const friendlyName = args[createAt + 1];
  const groups = (args[createAt + 2] || "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  if (!friendlyName || !groups.length) {
    console.error(
      'Usage: node examples/flights.js <app> --create "<friendly name>" <groupId>[,<groupId>]\n' +
        "The group is made in Partner Center; its id is in the URL when you open it."
    );
    process.exit(1);
  }
  const flight = await client.createFlight(storeId, {
    friendlyName,
    groupIds: groups,
  });
  console.log(`Created flight "${flight.friendlyName}"`);
  console.log(`  id:      ${flight.flightId}`);
  console.log(`  groups:  ${(flight.groupIds || []).join(", ")}`);
  console.log(
    `\nStage a build to it with:\n` +
      `  node examples/stage.js ${appArg} <package.msix> <notes.txt> --flight ${flight.flightId}`
  );
  process.exit(0);
}

if (deleteAt !== -1) {
  const flightId = args[deleteAt + 1];
  if (!flightId) {
    console.error("Usage: node examples/flights.js <app> --delete <flightId>");
    process.exit(1);
  }
  await client.deleteFlight(storeId, flightId);
  console.log(`Deleted flight ${flightId}. Testers fall back to the public release.`);
  process.exit(0);
}

const { value: flights = [] } = await client.listFlights(storeId);
if (!flights.length) {
  console.log(
    `${storeId} has no flights.\n\n` +
      "Make a tester group in Partner Center, then:\n" +
      `  node examples/flights.js ${appArg} --create "Vesopa Testers" <groupId>`
  );
  process.exit(0);
}

console.log(`${storeId} — ${flights.length} flight(s)\n`);
for (const f of flights) {
  console.log(`  ${f.friendlyName}`);
  console.log(`    id:       ${f.flightId}`);
  console.log(`    groups:   ${(f.groupIds || []).join(", ") || "(none)"}`);
  console.log(
    `    pending:  ${
      f.pendingFlightSubmission
        ? `${f.pendingFlightSubmission.id} — in progress`
        : "none"
    }`
  );
  console.log(
    `    last published: ${f.lastPublishedFlightSubmission?.id || "never"}`
  );
  console.log("");
}
