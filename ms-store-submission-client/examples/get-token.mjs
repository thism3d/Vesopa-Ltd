// Prints an Azure AD access token for the Store submission API, and how long
// it lasts. Read-only: it authenticates and changes nothing in Partner Center.
//
//     node examples/get-token.mjs
//
// A token is valid for about 60 minutes, so it is worth fetching when needed
// rather than saving. What belongs in .env is MS_STORE_CLIENT_ID and
// MS_STORE_CLIENT_SECRET; every script here mints its own token from those.

import "dotenv/config";
import { getAccessToken } from "../src/auth.js";

const creds = {
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
};

const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Not set in .env: ${missing.join(", ")}`);
  console.error("Partner Center > Account settings > Users > Azure AD applications.");
  process.exit(1);
}

const token = await getAccessToken(creds);
const [, payload] = token.split(".");
const claims = JSON.parse(Buffer.from(payload, "base64url").toString());

console.log(token);
console.log();
console.log(`audience:  ${claims.aud}`);
console.log(`app id:    ${claims.appid}`);
console.log(`expires:   ${new Date(claims.exp * 1000).toISOString()}`);
