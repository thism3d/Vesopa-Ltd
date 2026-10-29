/**
 * BulkSMSBD (bulksmsbd.net) — SMS to Bangladeshi mobiles from the admin panel.
 *
 * Key and sender ID live in .env (BULKSMSBD_API_KEY, BULKSMSBD_SENDER_ID),
 * never in the repository. Success is response_code 202; anything else is a
 * refusal whose code we hand back to the admin as-is.
 */

const BASE = 'https://bulksmsbd.net/api';

const CODES = {
  202: 'Sent',
  1001: 'Invalid number',
  1002: 'Sender ID not correct or disabled',
  1003: 'Required fields missing',
  1005: 'Internal error at BulkSMSBD',
  1006: 'Balance validity not available',
  1007: 'Balance insufficient',
  1011: 'User ID not found',
  1012: 'Masking SMS must be sent in Bengali',
  1013: 'Sender ID has no gateway for this API key',
  1014: 'Sender type name not found',
  1015: 'Sender ID has no valid gateway',
  1016: 'Sender type price info not found',
  1017: 'Sender type price not found',
  1018: 'Account disabled',
  1019: 'Sender type price disabled',
  1020: 'Parent account not found',
  1021: 'Parent active sender type price not found',
  1031: 'Account not verified, contact BulkSMSBD',
  1032: 'IP not whitelisted',
};

const configured = () => Boolean(process.env.BULKSMSBD_API_KEY && process.env.BULKSMSBD_SENDER_ID);

/** 01XXXXXXXXX, +8801…, 8801…, with spaces or dashes → 8801XXXXXXXXX, or null. */
function normaliseNumber(raw) {
  let n = String(raw || '').replace(/[^\d]/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('01') && n.length === 11) n = '88' + n;
  if (n.startsWith('1') && n.length === 10) n = '880' + n;
  return /^8801[3-9]\d{8}$/.test(n) ? n : null;
}

async function call(path, params) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { response_code: 0, error_message: text.slice(0, 200) || `HTTP ${res.status}` };
  }
}

async function balance() {
  if (!configured()) return null;
  const r = await call('getBalanceApi', { api_key: process.env.BULKSMSBD_API_KEY });
  return Number(r.response_code) === 202 ? Number(r.balance) : null;
}

/** numbers: array of normalised numbers. Returns { ok, code, message }. */
async function send(numbers, message) {
  if (!configured()) return { ok: false, code: 0, message: 'BulkSMSBD is not set up on this server' };
  const unicode = /[^\x00-\x7F]/.test(message);
  const r = await call('smsapi', {
    api_key: process.env.BULKSMSBD_API_KEY,
    senderid: process.env.BULKSMSBD_SENDER_ID,
    type: unicode ? 'unicode' : 'text',
    number: numbers.join(','),
    message,
  });
  const code = Number(r.response_code);
  return {
    ok: code === 202,
    code,
    message: r.success_message || r.error_message || CODES[code] || `Code ${code}`,
  };
}

module.exports = { configured, normaliseNumber, balance, send };
