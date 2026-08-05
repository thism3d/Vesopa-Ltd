/**
 * The email an admin sends when a subscription is close to its term end, or
 * past it.
 *
 * Written to be reassuring rather than threatening, because the till is not
 * being switched off and telling a shop otherwise would be a lie. The whole
 * point of the design is that a lapsed payment is a conversation, not an
 * outage — so the mail says so in as many words.
 *
 * The admin can rewrite the body before it goes; this is the starting draft.
 */

const { esc } = require('./notification');
const { CONTACT, BRAND, SITE_URL } = require('../config');

/**
 * @param {object} o
 * @param {string} o.officeName
 * @param {string} o.contactName   who to address; falls back to the office name
 * @param {string} o.dueLabel      "12 Aug 2026"
 * @param {number} o.days          negative once overdue
 * @param {string} o.amount        already formatted, e.g. "£225.00"
 * @param {string} o.planName
 * @param {string} o.body          the admin's message, plain text
 */
function renderRenewalReminder({
  officeName, contactName, dueLabel, days, amount, planName, body,
}) {
  const overdue = typeof days === 'number' && days < 0;

  const headline = overdue
    ? 'Your Vesopa subscription is due for renewal'
    : 'Your Vesopa subscription renews soon';

  const paragraphs = String(body || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 16px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px; color:#354248;">${esc(
          p
        ).replace(/\n/g, '<br>')}</p>`
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(headline)}</title>
</head>
<body style="margin:0; padding:0; background:#f4f6f4;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f4; padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e2e7e2;">

        <tr>
          <td style="background:#000000; padding:22px 28px;">
            <span style="font-family:Arial,Helvetica,sans-serif; font-size:19px; font-weight:bold; color:#ffffff; letter-spacing:.04em;">
              VESOPA<span style="color:${BRAND.green};"> EPOS</span>
            </span>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 28px 8px;">
            <h1 style="margin:0 0 6px; font-family:Arial,Helvetica,sans-serif; font-size:21px; line-height:28px; color:#000000;">
              ${esc(headline)}
            </h1>
            <p style="margin:0 0 20px; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:#6b7780;">
              ${esc(officeName)}
            </p>

            <p style="margin:0 0 16px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px; color:#354248;">
              Hi ${esc(contactName || officeName)},
            </p>

            ${paragraphs}
          </td>
        </tr>

        <tr>
          <td style="padding:4px 28px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                   style="background:#f7faec; border:1px solid #e4eeba; border-radius:10px;">
              <tr>
                <td style="padding:16px 18px; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:24px; color:#354248;">
                  <strong style="color:#000;">Plan</strong> &nbsp;${esc(planName || '—')}<br>
                  <strong style="color:#000;">Amount</strong> &nbsp;${esc(amount)}<br>
                  <strong style="color:#000;">${overdue ? 'Was due' : 'Renews on'}</strong> &nbsp;${esc(dueLabel)}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!--
          The important sentence in the whole email. A shop that thinks its
          tills are about to stop will panic on a Friday night; they will not.
        -->
        <tr>
          <td style="padding:0 28px 26px;">
            <p style="margin:0; padding:14px 16px; background:#f2f5f6; border-left:3px solid ${BRAND.green}; border-radius:6px;
                      font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:22px; color:#354248;">
              <strong style="color:#000;">Your tills keep working.</strong> Nothing is switched
              off while we sort the renewal out — you can carry on trading and
              take payments exactly as normal.
            </p>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:0 28px 30px;">
            <a href="${SITE_URL}/pricing"
               style="display:inline-block; background:${BRAND.green}; color:#101401; text-decoration:none;
                      font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:bold;
                      padding:13px 30px; border-radius:8px;">
              Renew my subscription
            </a>
          </td>
        </tr>

        <tr>
          <td style="padding:20px 28px; background:#fafbfa; border-top:1px solid #e2e7e2;
                     font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:21px; color:#6b7780;">
            Prefer to talk it through? Call us on
            <a href="tel:${esc(CONTACT.emergency_phone_e164)}" style="color:#5f7d0a;">${esc(CONTACT.emergency_phone)}</a>
            or reply to this email.<br><br>
            ${esc(CONTACT.company)} · ${esc(CONTACT.address_line1)}, ${esc(CONTACT.address_line2)}
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** The wording the compose box is pre-filled with. */
function defaultReminderBody({ officeName, dueLabel, days, amount }) {
  const overdue = typeof days === 'number' && days < 0;

  if (overdue) {
    return [
      `Your Vesopa EPOS subscription for ${officeName} was due for renewal on ${dueLabel}, and we haven't been able to take the payment yet.`,
      `The amount outstanding is ${amount}. Nothing has been switched off — your tills and back office are working normally and will keep working while we get this sorted.`,
      `If you can renew at your convenience, or let us know a better time to take payment, we'll get it squared away. If anything has changed with the business, just tell us and we'll work around it.`,
      `Thanks for trading with us.`,
    ].join('\n\n');
  }

  return [
    `Your Vesopa EPOS subscription for ${officeName} is due to renew on ${dueLabel}.`,
    `The amount for the coming term is ${amount}. There's nothing you need to do if you're happy to continue — this is just so the date isn't a surprise.`,
    `If you'd like to change plan, add a till, or talk about anything else, reply to this email or give us a ring and we'll sort it out.`,
    `Thanks for trading with us.`,
  ].join('\n\n');
}

module.exports = { renderRenewalReminder, defaultReminderBody };
