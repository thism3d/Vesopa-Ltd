'use strict';

/**
 * Emails for Vesopa EPOS subscriptions billed through Dojo (2026-10-24).
 * Same frame as renewal-reminder.js: black header, white card, one lime
 * button, plain words. One renderer, one entry per moment in a subscription.
 */
const { esc } = require('./notification');
const { CONTACT, BRAND } = require('../config');

const KINDS = {
  trial_started: {
    subject: (d) => `Your Vesopa EPOS trial has started: ${d.venue}`,
    headline: 'Your 14-day free trial has started',
    body: (d) => [
      `Thank you for choosing Vesopa EPOS. The £1 card check has been refunded to you, so nothing has been taken.`,
      `Your trial runs until ${d.date}. Three days before, we will email you a secure Dojo link to pay the first ${d.amount}, by card, Apple Pay or Google Pay. If you would rather not carry on, simply do not pay; nothing is taken automatically.`,
      `We will be in touch to set up your till, your menu and your card machine with you.`,
    ],
  },
  trial_ending: {
    subject: (d) => `Your Vesopa EPOS trial ends on ${d.date}`,
    headline: 'Your free trial ends soon',
    body: (d) => [`Your free trial ends on ${d.date}. To keep your tills running after that, pay the first ${d.amount} with the button below: card, Apple Pay or Google Pay, secured by Dojo.`, `To change your plan or ask anything, just reply to this email.`],
    button: 'Pay and keep my tills running',
  },
  paid: {
    subject: (d) => `Payment received, thank you: invoice ${d.invoice}`,
    headline: 'Payment received',
    body: (d) => [`We have received ${d.amount} for ${d.plan}. Your subscription now runs until ${d.date}.`],
  },
  renewal_due: {
    subject: (d) => `Your Vesopa EPOS renewal: ${d.amount} due ${d.date}`,
    headline: 'Your subscription renews soon',
    body: (d) => [`Your ${d.plan} plan renews on ${d.date}. Pay securely with Dojo using the button below: card, Apple Pay or Google Pay.`],
    button: 'Pay my renewal',
  },
  payment_failed: {
    subject: (d) => `Action needed: your Vesopa EPOS payment did not go through`,
    headline: 'Your payment did not go through',
    body: (d) => [
      `We could not take ${d.amount} for your ${d.plan} plan${d.reason ? ` (${d.reason})` : ''}.`,
      d.final
        ? `This was our last try. Please pay using the button below so your tills keep working.`
        : `We will try again on ${d.next}. You can also pay now with the button below, with any card, Apple Pay or Google Pay.`,
    ],
    button: 'Pay now',
    tillsOk: true,
  },
  suspended: {
    subject: (d) => `Your Vesopa EPOS subscription is on hold`,
    headline: 'Your subscription is on hold',
    body: (d) => [
      `We have not been able to take payment of ${d.amount}, so your subscription is on hold. Your tills will stop taking new sales at the end of the grace period.`,
      `Pay with the button below and everything is switched back on straight away.`,
    ],
    button: 'Pay and switch back on',
  },
  restored: {
    subject: () => `Your Vesopa EPOS subscription is active again`,
    headline: 'You are all set',
    body: (d) => [`Thank you, payment received. Your subscription is active again until ${d.date}.`],
  },
  cancelled: {
    subject: () => `Your Vesopa EPOS subscription has been cancelled`,
    headline: 'Subscription cancelled',
    body: (d) => [d.date ? `Your subscription has been cancelled and stays active until ${d.date}. Nothing more will be taken.` : `Your subscription has been cancelled. Nothing more will be taken.`, `If this was a mistake, reply to this email and we will put it back.`],
  },
  card_link: {
    subject: () => `Update the card for your Vesopa EPOS subscription`,
    headline: 'Update your card',
    body: (d) => [`Use the button below to pay ${d.amount} with a new card, Apple Pay or Google Pay. The link is secured by Dojo.`],
    button: 'Pay with a new card',
  },
  refunded: {
    subject: (d) => `Refund of ${d.amount} on its way`,
    headline: 'Refund on its way',
    body: (d) => [`We have refunded ${d.amount} to your card. It usually reaches your account in 3 to 5 working days.`],
  },
};

function render(kind, d) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown subscription email: ${kind}`);
  const p = (t) => `<p style="margin:0 0 16px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px; color:#354248;">${esc(t)}</p>`;
  const rows = [
    ['Venue', d.venue], ['Plan', d.plan], d.amount ? ['Amount', d.amount] : null, d.invoice ? ['Invoice', d.invoice] : null,
  ].filter(Boolean).map(([a, b]) => `<strong style="color:#000;">${esc(a)}</strong> &nbsp;${esc(b || '-')}`).join('<br>');
  const button = k.button && d.url
    ? `<tr><td align="center" style="padding:0 28px 30px;"><a href="${esc(d.url)}" style="display:inline-block; background:${BRAND.green}; color:#101401; text-decoration:none; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:bold; padding:13px 30px; border-radius:8px;">${esc(k.button)}</a></td></tr>`
    : '';
  const tills = k.tillsOk
    ? `<tr><td style="padding:0 28px 22px;"><p style="margin:0; padding:14px 16px; background:#f2f5f6; border-left:3px solid ${BRAND.green}; border-radius:6px; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:22px; color:#354248;"><strong style="color:#000;">Your tills keep working</strong> while we sort this out.</p></td></tr>`
    : '';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(k.headline)}</title></head>
<body style="margin:0; padding:0; background:#f4f6f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f4; padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e2e7e2;">
<tr><td style="background:#000000; padding:22px 28px;"><span style="font-family:Arial,Helvetica,sans-serif; font-size:19px; font-weight:bold; color:#ffffff; letter-spacing:.04em;">VESOPA<span style="color:${BRAND.green};"> EPOS</span></span></td></tr>
<tr><td style="padding:28px 28px 8px;">
<h1 style="margin:0 0 18px; font-family:Arial,Helvetica,sans-serif; font-size:21px; line-height:28px; color:#000000;">${esc(k.headline)}</h1>
${p(`Hi ${d.name || d.venue},`)}
${k.body(d).map(p).join('')}
</td></tr>
<tr><td style="padding:4px 28px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7faec; border:1px solid #e4eeba; border-radius:10px;"><tr><td style="padding:16px 18px; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:24px; color:#354248;">${rows}</td></tr></table></td></tr>
${tills}${button}
<tr><td style="padding:20px 28px; background:#fafbfa; border-top:1px solid #e2e7e2; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:21px; color:#6b7780;">Questions? Call <a href="tel:${esc(CONTACT.emergency_phone_e164)}" style="color:#5f7d0a;">${esc(CONTACT.emergency_phone)}</a> or reply to this email. Payments are processed securely by Dojo; Vesopa never sees your card number.<br><br>${esc(CONTACT.company)} · ${esc(CONTACT.address_line1)}, ${esc(CONTACT.address_line2)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: k.subject(d), html };
}

module.exports = { render, KINDS };
