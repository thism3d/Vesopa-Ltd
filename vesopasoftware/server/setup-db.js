/* Create the database and apply the schema, then stop. `npm run db:setup` */
import { setup, pool } from "./lib/db.js";
import { config } from "./lib/config.js";

setup()
  .then(async () => {
    console.log(`  database '${config.db.database}' ready on ${config.db.host}:${config.db.port}`);
    await pool.end();
  })
  .catch((err) => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  });
