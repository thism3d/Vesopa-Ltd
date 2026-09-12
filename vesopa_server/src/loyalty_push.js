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
const http2 = require('http2');

const jwt = require('jsonwebtoken');
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


// ---- Android (FCM) ---------------------------------------------------------
//
// The Play Store build. FCM HTTP v1, authenticated as a Google service account
// -- not the old server key, which Google has retired.
//
// This is the one place Firebase enters the product, and only as a delivery
// pipe: Android has no other way to wake an app that is not running. Nothing
// about a customer is stored there, and the web and Windows builds still use
// Web Push and WNS exactly as they did.
//
// Configured with FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY in .env.
// Absent, Android channels are skipped and the back office says so -- the same
// shape as WNS without its Partner Center credentials.

const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token';
let fcmToken = null;

function fcmCreds() {
  const projectId = process.env.FCM_PROJECT_ID || '';
  const clientEmail = process.env.FCM_CLIENT_EMAIL || '';
  // Kept in .env on one line with escaped newlines, which is how Google hands
  // the key over; turned back into real ones here.
  const privateKey = (process.env.FCM_PRIVATE_KEY || '').split('\\n').join('\n');
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

const fcmReady = () => fcmCreds() !== null;

async function fcmAccessToken(creds, { fresh = false } = {}) {
  if (!fresh && fcmToken && fcmToken.until > Date.now()) return fcmToken.token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: creds.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: FCM_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
    creds.privateKey,
    { algorithm: 'RS256' }
  );
  const res = await fetch(FCM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`FCM sign-in refused (${res.status})`);
  const body = await res.json();
  const lifetime = Math.max(60, Number(body.expires_in) || 3600) * 1000;
  fcmToken = { token: body.access_token, until: Date.now() + lifetime - 60_000 };
  return fcmToken.token;
}

/** Send one Android notification. Resolves to 'ok', 'gone' or 'failed'. */
async function sendFcm(channel, payload) {
  const creds = fcmCreds();
  if (!creds) return 'failed';
  const body = {
    message: {
      token: channel.endpoint,
      notification: {
        title: String(payload.title || ''),
        body: String(payload.body || ''),
      },
      // Strings only: FCM refuses a data payload holding any other type, and a
      // refusal looks exactly like a dead device unless you read the body.
      data: {
        id: String(payload.id || ''),
        link: String(payload.link || ''),
        url: String(payload.url || ''),
      },
      android: { notification: { image: payload.image || undefined } },
    },
  };
  const post = async (token) =>
    fetch(`https://fcm.googleapis.com/v1/projects/${creds.projectId}/messages:send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  try {
    let res = await post(await fcmAccessToken(creds));
    if (res.status === 401) res = await post(await fcmAccessToken(creds, { fresh: true }));
    if (res.ok) return 'ok';
    // The app was uninstalled, or the token was replaced. Forgotten rather than
    // retried for the next ten sends at a device that no longer exists.
    if (res.status === 404 || res.status === 400) return 'gone';
    return 'failed';
  } catch {
    return 'failed';
  }
}

// ---- iPhone (APNs) ---------------------------------------------------------
//
// The App Store build. APNs over HTTP/2 with a token-based (.p8) key, which is
// one key for every app under the Apple developer account rather than a
// certificate per app that expires every year.
//
// Configured with APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY and APNS_TOPIC
// (the bundle id). APNS_ENV=sandbox points at Apple's test gateway.

const APNS_HOST = () =>
  process.env.APNS_ENV === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';

let apnsToken = null;

function apnsCreds() {
  const keyId = process.env.APNS_KEY_ID || '';
  const teamId = process.env.APNS_TEAM_ID || '';
  const privateKey = (process.env.APNS_PRIVATE_KEY || '').split('\\n').join('\n');
  const topic = process.env.APNS_TOPIC || '';
  if (!keyId || !teamId || !privateKey || !topic) return null;
  return { keyId, teamId, privateKey, topic };
}

const apnsReady = () => apnsCreds() !== null;

/**
 * Apple's provider token. Good for an hour, and Apple REFUSES one refreshed
 * more than about every twenty minutes -- so it is cached rather than minted
 * per send. Getting this wrong has every notification rejected with 429, which
 * reads like a broken key rather than too many tokens.
 */
function apnsAuthToken(creds) {
  if (apnsToken && apnsToken.until > Date.now()) return apnsToken.token;
  const token = jwt.sign(
    { iss: creds.teamId, iat: Math.floor(Date.now() / 1000) },
    creds.privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: creds.keyId } }
  );
  apnsToken = { token, until: Date.now() + 45 * 60_000 };
  return token;
}

/** Send one iPhone notification. Resolves to 'ok', 'gone' or 'failed'. */
async function sendApns(channel, payload) {
  const creds = apnsCreds();
  if (!creds) return 'failed';
  // A device token is hex and nothing else, and it goes straight into a URL
  // path -- so it is checked here rather than trusted from the device.
  if (!/^[0-9a-f]{16,200}$/i.test(String(channel.endpoint || ''))) return 'gone';

  const body = JSON.stringify({
    aps: {
      alert: { title: String(payload.title || ''), body: String(payload.body || '') },
      sound: 'default',
      'mutable-content': payload.image ? 1 : 0,
    },
    id: payload.id || null,
    link: payload.link || null,
    url: payload.url || null,
    image: payload.image || null,
  });

  return new Promise((resolve) => {
    let settled = false;
    const session = http2.connect(APNS_HOST());
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { session.close(); } catch { /* already gone */ }
      resolve(value);
    };

    session.on('error', () => done('failed'));
    session.setTimeout(10_000, () => done('failed'));

    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${channel.endpoint}`,
      authorization: `bearer ${apnsAuthToken(creds)}`,
      'apns-topic': creds.topic,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    req.on('error', () => done('failed'));
    req.on('response', (headers) => {
      const status = Number(headers[':status']);
      if (status === 200) return done('ok');
      // 410 is Apple saying the app has gone from that phone; 400 covers a
      // token that was never valid for this app.
      if (status === 410 || status === 400) return done('gone');
      done('failed');
    });
    req.end(body);
  });
}

module.exports = {
  webPushReady,
  vapid,
  sendWebPush,
  sendWns,
  sendFcm,
  sendApns,
  fcmReady,
  apnsReady,
  allowedWebPush,
  allowedWns,
  toastXml,
};
