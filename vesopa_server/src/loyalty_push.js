/**
 * Sending a notification to one phone or PC: Web Push, or Windows (WNS).
 *
 * WHY THE HOSTS ARE CHECKED
 *
 * A push subscription is an address the *customer's device* gave us, and this
 * server then makes an HTTPS request to it. Taken on trust, that is a way to
 * make the server call anything -- including addresses on its own network. So
 * both channels only ever post to the push services that exist: the browsers'
 * (Google, Mozilla, Apple, Microsoft) for Web Push, and Microsoft's for WNS.
 *
 * WEB PUSH
 *
 * Standard VAPID Web Push (RFC 8030/8291/8292) via the `web-push` package: no
 * Firebase, no per-app account. The keys are the server's own
 * (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT in .env). Reaches Chrome,
 * Edge and Firefox on Android and desktop, and Safari on an iPhone where the app
 * has been added to the home screen (iOS 16.4+).
 *
 * WINDOWS (WNS)
 *
 * The venue's own Windows app from the Microsoft Store registers a channel URI;
 * the server authenticates as that app (its Package SID and secret from Partner
 * Center, per venue) and posts a toast. Microsoft shows it; the app need not be
 * running.
 */
const webpush = require('web-push');

const WEB_PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/i,
  /(^|\.)android\.googleapis\.com$/i,
  /(^|\.)push\.services\.mozilla\.com$/i,
  /(^|\.)push\.apple\.com$/i,
  /(^|\.)notify\.windows\.com$/i,
];
const WNS_HOSTS = [/(^|\.)notify\.windows\.com$/i];

function hostAllowed(url, patterns) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && patterns.some((p) => p.test(u.hostname));
  } catch {
    return false;
  }
}

const allowedWebPush = (url) => hostAllowed(url, WEB_PUSH_HOSTS);
const allowedWns = (url) => hostAllowed(url, WNS_HOSTS);

// ---- Web Push --------------------------------------------------------------

function vapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT || 'mailto:info@vesopa.com',
  };
}

const webPushReady = () => vapid() !== null;

/**
 * Send one Web Push. Resolves to 'ok', 'gone' (the subscription is dead and
 * should be forgotten) or 'failed'.
 */
async function sendWebPush(channel, payload) {
  const keys = vapid();
  if (!keys) return 'failed';
  if (!allowedWebPush(channel.endpoint)) return 'gone';
  try {
    await webpush.sendNotification(
      {
        endpoint: channel.endpoint,
        keys: { p256dh: channel.p256dh, auth: channel.auth_secret },
      },
      JSON.stringify(payload),
      {
        TTL: 24 * 3600,
        urgency: 'normal',
        vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        timeout: 10_000,
      }
    );
    return 'ok';
  } catch (e) {
    // 404 and 410 are the push service saying this subscription no longer
    // exists -- the app was uninstalled or notifications were turned off.
    if (e && (e.statusCode === 404 || e.statusCode === 410)) return 'gone';
    return 'failed';
  }
}

// ---- Windows (WNS) -----------------------------------------------------------

const wnsTokens = new Map(); // packageSid -> { token, until }

async function wnsToken(packageSid, secret, { fresh = false } = {}) {
  const hit = wnsTokens.get(packageSid);
  if (!fresh && hit && hit.until > Date.now()) return hit.token;
  const res = await fetch('https://login.live.com/accesstoken.srf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: packageSid,
      client_secret: secret,
      scope: 'notify.windows.com',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`WNS sign-in refused (${res.status})`);
  const body = await res.json();
  const token = body.access_token;
  const lifetime = Math.max(60, Number(body.expires_in) || 3600) * 1000;
  wnsTokens.set(packageSid, { token, until: Date.now() + lifetime - 60_000 });
  return token;
}

const xml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The toast Windows draws: the venue's words, and where a tap opens the app. */
function toastXml(payload) {
  const launch = xml(JSON.stringify({ message: payload.id || null, link: payload.link || null }));
  const image = payload.image
    ? `<image placement="hero" src="${xml(payload.image)}"/>`
    : '';
  return `<toast launch="${launch}" activationType="foreground"><visual><binding template="ToastGeneric">`
    + `<text>${xml(payload.title)}</text><text>${xml(payload.body)}</text>${image}`
    + '</binding></visual></toast>';
}

/** Send one WNS toast. Resolves to 'ok', 'gone' or 'failed'. */
async function sendWns(channel, payload, creds) {
  if (!creds || !creds.packageSid || !creds.secret) return 'failed';
  if (!allowedWns(channel.endpoint)) return 'gone';
  const post = async (token) => fetch(channel.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-WNS-Type': 'wns/toast',
      Authorization: `Bearer ${token}`,
    },
    body: toastXml(payload),
    signal: AbortSignal.timeout(10_000),
  });
  try {
    let res = await post(await wnsToken(creds.packageSid, creds.secret));
    if (res.status === 401) {
      res = await post(await wnsToken(creds.packageSid, creds.secret, { fresh: true }));
    }
    if (res.ok) return 'ok';
    if (res.status === 404 || res.status === 410) return 'gone';
    return 'failed';
  } catch {
    return 'failed';
  }
}

module.exports = {
  webPushReady,
  vapid,
  sendWebPush,
  sendWns,
  allowedWebPush,
  allowedWns,
  toastXml,
};
