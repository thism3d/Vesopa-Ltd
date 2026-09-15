/**
 * What arrives in somebody's inbox.
 *
 * Built like the loyalty app's emails (vesopa_server/src/loyalty_email.js), and
 * for the same reason: tables, inline styles, one 600px column, nothing a mail
 * client can strip. Outlook renders with Word's engine and Gmail drops <style>
 * blocks, and a layout that assumes anything newer comes out as a column of
 * unstyled text where people actually read email.
 *
 * Images travel as attachments with a Content-ID rather than links, so a voucher
 * shows its picture and its QR code even in a client that blocks remote images
 * by default -- which is most of them, for a sender they have not seen before.
 *
 * Every message has a text part written by hand. A voucher code is exactly the
 * thing somebody reads off a watch.
 */

const { esc, money, when, dateLong, onColour, initials } = require('./util');

// Single quotes only: these go inside style="..." attributes, and a double
// quote there ends the attribute -- everything after the font (colour, padding,
// the button's background) was being thrown away by every mail client.
const SAFE = "Arial, 'Helvetica Neue', Helvetica, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

function layout(brand, { preheader = '', body = '', footer = '' }) {
  const primary = /^#[0-9a-f]{6}$/i.test(String(brand.primary)) ? brand.primary : '#1f2a24';
  const ink = onColour(primary);
  const name = esc(brand.name);
  const logo = brand.icon || brand.logo || null;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f0;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f0;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;">
      <tr><td style="background:${primary};padding:22px 26px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="padding-right:12px;" valign="middle">${logo
            ? `<img src="${esc(logo)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border-radius:9px;border:0;background:#ffffff;">`
            : `<div style="width:40px;height:40px;border-radius:9px;background:#ffffff;text-align:center;font:700 15px/40px ${SERIF};color:${primary};">${esc(initials(brand.name))}</div>`}</td>
          <td valign="middle"><span style="font:700 19px/1.2 ${SAFE};color:${ink};">${name}</span></td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:28px 26px 8px 26px;font:400 16px/1.5 ${SAFE};color:#111111;">${body}</td></tr>
      <tr><td style="padding:16px 26px 28px 26px;font:400 13px/1.5 ${SAFE};color:#6b6b6b;">
        ${footer ? `<p style="margin:0 0 10px 0;">${footer}</p>` : ''}
        <p style="margin:0;">Sent by ${name} · powered by Vesopa</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function button(href, label, { dark = true } = {}) {
  return dark
    ? `<a href="${esc(href)}" style="display:inline-block;background:#111111;color:#ffffff;font:700 14px/44px ${SAFE};padding:0 18px;border-radius:10px;text-decoration:none;">${esc(label)}</a>`
    : `<a href="${esc(href)}" style="display:inline-block;border:1px solid #d5d8d1;color:#111111;font:700 14px/42px ${SAFE};padding:0 18px;border-radius:10px;text-decoration:none;">${esc(label)}</a>`;
}

/** The card: the picture, and a plate beneath it with the name and the value. */
function card(brand, { artCid, value, caption }) {
  const primary = /^#[0-9a-f]{6}$/i.test(String(brand.primary)) ? brand.primary : '#1f2a24';
  const picture = artCid
    ? `<img src="cid:${artCid}" width="548" alt="" style="display:block;width:100%;max-width:548px;height:auto;border:0;">`
    : `<div style="height:140px;background:${primary};"></div>`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px;overflow:hidden;border:1px solid #e6e8e3;">
      <tr><td>${picture}</td></tr>
      <tr><td style="padding:14px 18px;background:#ffffff;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font:700 16px/1.3 ${SERIF};color:#14161a;">${esc(brand.name)}<br><span style="font:400 12px/1.6 ${SAFE};letter-spacing:1px;text-transform:uppercase;color:#63696f;">${esc(caption)}</span></td>
          <td align="right" style="font:400 36px/1 ${SERIF};color:#14161a;">${esc(value)}</td>
        </tr></table>
      </td></tr>
    </table>`;
}

function codeBlock({ qrCid, code, expires }) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e6e8e3;border-radius:12px;">
      <tr>
        <td width="132" style="padding:14px;"><img src="cid:${qrCid}" width="116" height="116" alt="QR code" style="display:block;border:0;"></td>
        <td style="padding:14px 14px 14px 0;font:400 14px/1.5 ${SAFE};color:#6b6b6b;">
          Your voucher code<br>
          <span style="font:700 24px/1.3 'Courier New', Courier, monospace;letter-spacing:3px;color:#111111;">${esc(code)}</span><br>
          ${expires ? `Valid until ${esc(dateLong(expires))}` : ''}
        </td>
      </tr>
    </table>`;
}

/** The voucher itself, to whoever is going to spend it. */
function voucherEmail({ brand, order, line, viewUrl, balanceUrl, artCid, qrCid, toBuyer }) {
  const who = line.recipient_name || (toBuyer ? order.buyer_name : '');
  const value = line.kind === 'experience' ? money(line.unit_minor) : money(line.unit_minor);
  const caption = line.kind === 'experience' ? line.label : 'Gift voucher';
  const giver = order.buyer_name.split(' ')[0];
  const headline = toBuyer
    ? `Your ${esc(caption.toLowerCase() === 'gift voucher' ? 'voucher' : caption)} is ready.`
    : `${esc(who ? who.split(' ')[0] : 'Hello')}, you have been given a gift.`;
  const intro = toBuyer
    ? `Here is the ${esc(value)} voucher you bought for ${esc(line.recipient_name || 'somebody special')}. Print it, forward this email, or show it on your phone.`
    : `${esc(giver)} has sent you ${line.kind === 'experience' ? `<strong>${esc(line.label)}</strong>` : `a <strong>${esc(value)} voucher</strong>`} for ${esc(brand.name)}${line.message ? ', with a note:' : '.'}`;
  const note = line.message
    ? `<div style="background:#f4f5f1;border-radius:12px;padding:16px 18px;margin:14px 0 0 0;font:italic 17px/1.5 ${SERIF};color:#111111;">“${esc(line.message)}”<div style="font:14px/1.5 ${SAFE};font-style:normal;color:#6b6b6b;margin-top:6px;">${esc(giver)}</div></div>`
    : '';
  const wait = line.usable_from && new Date(line.usable_from) > new Date()
    ? `<p style="margin:14px 0 0 0;font-size:14px;color:#b06d00;">It can be spent from ${esc(when(line.usable_from))}.</p>`
    : '';

  const html = layout(brand, {
    preheader: toBuyer ? `Your voucher for ${brand.name}` : `${giver} sent you a gift for ${brand.name}`,
    body: `
      <h1 style="margin:0 0 12px 0;font:700 26px/1.25 ${SERIF};color:#111111;">${headline}</h1>
      <p style="margin:0;">${intro}</p>
      ${note}
      <div style="height:18px;"></div>
      ${card(brand, { artCid, value, caption })}
      <div style="height:18px;"></div>
      ${codeBlock({ qrCid, code: line.card_code, expires: line.expires_on })}
      ${wait}
      <div style="height:18px;"></div>
      <p style="margin:0;">${button(viewUrl, line.wallet_url ? 'Open it on your phone' : 'Open your voucher')}</p>
      <p style="margin:18px 0 0 0;font-size:15px;color:#333333;"><strong style="color:#111111;">How to use it.</strong> Show the code or the QR when you pay, at the bar or at your table. ${line.kind === 'experience' ? '' : 'Spend it all at once or a bit at a time — whatever is left stays on it.'}</p>
      <p style="margin:10px 0 0 0;font-size:15px;color:#333333;">A copy to print is attached. You can check what is left at any time: <a href="${esc(balanceUrl)}" style="color:#111111;">${esc(balanceUrl.replace(/^https?:\/\//, ''))}</a></p>`,
    footer: toBuyer
      ? 'Treat the code like cash: anybody who has it can spend it.'
      : `${esc(giver)} bought this on ${esc(when(order.paid_at || order.created_at, { withTime: false }))}. If it reached you by mistake, reply to this email and the venue will put it right.`,
  });

  const text = [
    toBuyer ? `Your voucher for ${brand.name}` : `${giver} has sent you a gift for ${brand.name}.`,
    '',
    `${caption}: ${value}`,
    line.message ? `"${line.message}" — ${order.buyer_name}` : null,
    '',
    `Your code: ${line.card_code}`,
    line.expires_on ? `Valid until ${dateLong(line.expires_on)}` : null,
    wait ? `It can be spent from ${when(line.usable_from)}.` : null,
    '',
    'Show the code when you pay. A copy to print is attached.',
    `Open it: ${viewUrl}`,
    `Balance: ${balanceUrl}`,
  ].filter((x) => x !== null).join('\n');

  return { html, text };
}

/** The buyer's receipt, sent the moment the payment is seen. */
function receiptEmail({ brand, order, lines, ref, statusUrl }) {
  const rows = lines.map((l) => {
    const what = l.kind === 'ticket' ? `${l.quantity} × ${l.label}` : l.kind === 'experience' ? l.label : `Gift voucher${l.recipient_name ? ` for ${l.recipient_name}` : ''}`;
    const arrives = l.kind === 'ticket'
      ? 'Tickets sent to you now'
      : l.send_to === 'buyer'
        ? 'Sent to you now'
        : l.deliver_at
          ? `Emailed to ${l.recipient_email} on ${when(l.deliver_at)}`
          : `Emailed to ${l.recipient_email} now`;
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #e6e8e3;font:15px/1.4 ${SAFE};color:#111111;">${esc(what)}<br><span style="font-size:13px;color:#6b6b6b;">${esc(arrives)}</span></td>
      <td align="right" style="padding:10px 0;border-bottom:1px solid #e6e8e3;font:600 15px/1.4 ${SAFE};color:#111111;">${esc(money(l.unit_minor * l.quantity, { always: true }))}</td>
    </tr>`;
  }).join('');

  const html = layout(brand, {
    preheader: `Receipt ${ref} — ${money(order.total_minor, { always: true })}`,
    body: `
      <h1 style="margin:0 0 10px 0;font:700 24px/1.25 ${SERIF};color:#111111;">Thank you, ${esc(order.buyer_name.split(' ')[0])}.</h1>
      <p style="margin:0 0 16px 0;color:#333333;">Here is your receipt from ${esc(brand.name)}.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${rows}
        <tr>
          <td style="padding:12px 0 0 0;font:700 16px/1.4 ${SAFE};color:#111111;">Total paid</td>
          <td align="right" style="padding:12px 0 0 0;font:700 16px/1.4 ${SAFE};color:#111111;">${esc(money(order.total_minor, { always: true }))}</td>
        </tr>
      </table>
      <p style="margin:16px 0 0 0;font-size:14px;color:#6b6b6b;">Order ${esc(ref)}${order.card_last4 ? ` · card ending ${esc(order.card_last4)}` : ''} · ${esc(when(order.paid_at))}</p>
      <p style="margin:14px 0 0 0;">${button(statusUrl, 'See your order', { dark: false })}</p>`,
    footer: 'Changed your mind about the day, or spelled an address wrong? Reply to this email and the venue will sort it before it goes.',
  });
  const text = [
    `Thank you. Your receipt from ${brand.name}.`,
    '',
    ...lines.map((l) => `${l.kind === 'ticket' ? `${l.quantity} x ` : ''}${l.label}: ${money(l.unit_minor * l.quantity, { always: true })}`),
    `Total paid: ${money(order.total_minor, { always: true })}`,
    '',
    `Order ${ref}`,
    `See your order: ${statusUrl}`,
  ].join('\n');
  return { html, text };
}

/** To the buyer, when a voucher they scheduled has gone. */
function sentEmail({ brand, order, line }) {
  const html = layout(brand, {
    preheader: `${line.recipient_name}'s voucher has been sent`,
    body: `
      <h1 style="margin:0 0 10px 0;font:700 22px/1.25 ${SERIF};color:#111111;">${esc(line.recipient_name)}’s voucher has gone.</h1>
      <p style="margin:0;color:#333333;">We have just emailed your ${esc(money(line.unit_minor))} ${line.kind === 'experience' ? esc(line.label) : 'voucher'} to ${esc(line.recipient_email)}, as you asked.</p>`,
  });
  const text = `${line.recipient_name}'s voucher from ${brand.name} has just been emailed to ${line.recipient_email}, as you asked.`;
  return { html, text };
}

/** To the venue, for every sale. */
function venueSaleEmail({ brand, order, lines, ref, adminUrl }) {
  const what = lines.map((l) => `${l.kind === 'ticket' ? `${l.quantity} × ` : ''}${l.label} — ${money(l.unit_minor * l.quantity, { always: true })}`).join('<br>');
  const html = layout(brand, {
    preheader: `New sale ${ref}: ${money(order.total_minor, { always: true })}`,
    body: `
      <h1 style="margin:0 0 10px 0;font:700 22px/1.25 ${SERIF};color:#111111;">New sale: ${esc(money(order.total_minor, { always: true }))}</h1>
      <p style="margin:0 0 12px 0;color:#333333;">${what}</p>
      <p style="margin:0;color:#6b6b6b;font-size:14px;">Bought by ${esc(order.buyer_name)} (${esc(order.buyer_email)}) · order ${esc(ref)}</p>
      <p style="margin:16px 0 0 0;">${button(adminUrl, 'Open the order', { dark: false })}</p>`,
    footer: 'The money has gone straight into your Dojo account.',
  });
  const text = `New sale ${ref}: ${money(order.total_minor, { always: true })}\n${lines.map((l) => l.label).join('\n')}\nBought by ${order.buyer_name} (${order.buyer_email})\n${adminUrl}`;
  return { html, text };
}

/** Tickets, all of them in one message, each with its own code. */
function ticketsEmail({ brand, order, event, tickets, typesById, viewUrl, qrCids }) {
  const rows = tickets.map((t, i) => `
    <tr><td style="padding:10px 0;border-bottom:1px solid #e6e8e3;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="100"><img src="cid:${qrCids[i]}" width="88" height="88" alt="" style="display:block;border:0;"></td>
        <td style="font:14px/1.5 ${SAFE};color:#6b6b6b;">
          <span style="font:700 15px/1.4 ${SAFE};color:#111111;">${esc((typesById[t.ticket_type_id] || {}).name || 'Ticket')}</span> · ticket ${i + 1} of ${tickets.length}<br>
          <span style="font:700 20px/1.4 'Courier New', Courier, monospace;letter-spacing:2px;color:#111111;">${esc(t.code)}</span>
        </td>
      </tr></table>
    </td></tr>`).join('');

  const html = layout(brand, {
    preheader: `Your tickets for ${event.title}`,
    body: `
      <h1 style="margin:0 0 8px 0;font:700 24px/1.25 ${SERIF};color:#111111;">${esc(event.title)}</h1>
      <p style="margin:0 0 4px 0;color:#333333;"><strong>${esc(when(event.starts_at))}</strong>${event.location ? ` · ${esc(event.location)}` : ''}</p>
      ${event.doors_at ? `<p style="margin:0;color:#6b6b6b;font-size:14px;">Doors at ${esc(when(event.doors_at).split(', ').pop())}</p>` : ''}
      <p style="margin:14px 0 6px 0;color:#333333;">Show these at the door, on your phone or on paper. Each one lets one person in, once.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
      <p style="margin:16px 0 0 0;">${button(viewUrl, 'Open your tickets')}</p>
      <p style="margin:10px 0 0 0;font-size:14px;color:#6b6b6b;">A copy to print is attached.</p>`,
    footer: `Tickets for ${esc(order.buyer_name)} · order paid ${esc(when(order.paid_at, { withTime: false }))}. Questions? Reply to this email.`,
  });
  const text = [
    `Your tickets for ${event.title}`,
    when(event.starts_at) + (event.location ? ` · ${event.location}` : ''),
    '',
    ...tickets.map((t, i) => `Ticket ${i + 1}: ${t.code}`),
    '',
    `Open them: ${viewUrl}`,
  ].join('\n');
  return { html, text };
}

/** To whoever holds a voucher, a month before it runs out, with what is left. */
function expiryEmail({ brand, line, balance, viewUrl, balanceUrl }) {
  const left = balance != null ? money(balance) : money(line.unit_minor);
  const html = layout(brand, {
    preheader: `Your ${brand.name} voucher runs out on ${dateLong(line.expires_on)}`,
    body: `
      <h1 style="margin:0 0 10px 0;font:700 22px/1.25 ${SERIF};color:#111111;">There is ${esc(left)} on your voucher, until ${esc(dateLong(line.expires_on))}.</h1>
      <p style="margin:0 0 14px 0;color:#333333;">A reminder from ${esc(brand.name)}: your ${line.kind === 'experience' ? esc(line.label) : 'gift voucher'} is valid until ${esc(dateLong(line.expires_on))}, and whatever is not spent by then is gone. Book a table, bring a friend.</p>
      <p style="margin:0;">${button(viewUrl, 'Open your voucher')} &nbsp; ${button(balanceUrl, 'Check the balance', { dark: false })}</p>`,
    footer: `Code ${esc(line.card_code)} · staff scan it at the till.`,
  });
  const text = `There is ${left} on your ${brand.name} voucher, valid until ${dateLong(line.expires_on)}. Code ${line.card_code}. ${viewUrl}`;
  return { html, text };
}

/** To the ticket buyer, the day before. */
function reminderEmail({ brand, order, event, count, viewUrl }) {
  const html = layout(brand, {
    preheader: `${event.title} is tomorrow`,
    body: `
      <h1 style="margin:0 0 10px 0;font:700 22px/1.25 ${SERIF};color:#111111;">${esc(event.title)} is tomorrow.</h1>
      <p style="margin:0 0 6px 0;color:#333333;"><strong>${esc(when(event.starts_at))}</strong>${event.doors_at ? ` · doors ${esc(when(event.doors_at).split(', ').pop())}` : ''}${event.location ? ` · ${esc(event.location)}` : ''}</p>
      <p style="margin:0 0 14px 0;color:#333333;">You have ${count} ticket${count === 1 ? '' : 's'} under ${esc(order.buyer_name)}. Have the QR codes ready on your phone at the door, or print them.</p>
      <p style="margin:0;">${button(viewUrl, 'Open your tickets')}</p>`,
  });
  const text = `${event.title} is tomorrow, ${when(event.starts_at)}${event.location ? `, ${event.location}` : ''}. Your ${count} ticket(s): ${viewUrl}`;
  return { html, text };
}

module.exports = { layout, voucherEmail, receiptEmail, sentEmail, venueSaleEmail, ticketsEmail, expiryEmail, reminderEmail };
