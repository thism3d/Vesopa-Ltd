// Azure AD (client-credentials) authentication for the Microsoft Store
// submission API. Getting a token costs nothing — it's a standard OAuth2
// client-credentials exchange against Azure AD, included with your
// Partner Center account.
//
// Docs: https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services

const TOKEN_RESOURCE = "https://manage.devcenter.microsoft.com";

let cachedToken = null; // { accessToken, expiresAt }

/**
 * Fetches (and caches) an Azure AD access token for the Store submission API.
 * Tokens are valid for 60 minutes; this refreshes a little early to be safe.
 *
 * @param {object} creds
 * @param {string} creds.tenantId
 * @param {string} creds.clientId
 * @param {string} creds.clientSecret
 * @param {boolean} [forceRefresh]
 */
export async function getAccessToken(creds, forceRefresh = false) {
  const { tenantId, clientId, clientSecret } = creds;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Missing tenantId/clientId/clientSecret. Set MS_STORE_TENANT_ID, " +
        "MS_STORE_CLIENT_ID and MS_STORE_CLIENT_SECRET (see .env.example)."
    );
  }

  const now = Date.now();
  if (!forceRefresh && cachedToken && cachedToken.expiresAt - now > 60_000) {
    return cachedToken.accessToken;
  }

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    resource: TOKEN_RESOURCE,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Azure AD token request failed (${res.status} ${res.statusText}): ${text}`
    );
  }

  const json = await res.json();
  // json.expires_in is seconds; json.expires_on is a unix timestamp (string)
  const expiresAt = json.expires_on
    ? Number(json.expires_on) * 1000
    : now + Number(json.expires_in ?? 3600) * 1000;

  cachedToken = { accessToken: json.access_token, expiresAt };
  return cachedToken.accessToken;
}
