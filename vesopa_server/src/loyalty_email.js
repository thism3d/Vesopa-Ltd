/**
 * The emails a venue's loyalty app sends, in the venue's own clothes.
 *
 * WHAT WAS WRONG WITH THE OLD ONE
 *
 * The sign-in code email was a div with an inline font stack, a heading and the
 * code in bold. It worked, and it looked like nothing: no logo, no colour, no
 * venue. A member who has just tapped "send me a code" for The Vesopa Kitchen
 * gets an email that could be from anybody, which is exactly the shape of
 * message people have been taught to be suspicious of.
 *
 * WHY IT IS BUILT LIKE 2003
 *
 * Tables, inline styles, no flexbox, no grid, no external stylesheet. Not
 * nostalgia: Outlook on Windows renders with Word's engine, Gmail strips
 * <style> blocks in some clients, and a layout that assumes anything modern
 * collapses into a column of unstyled text in the places people actually read
 * email. Every rule that matters is on the element it applies to.
 *
 *   * One table, one column, 600px maximum -- the width every client handles.
 *   * Colours inline, with a readable fallback if the venue has set none.
 *   * A text/plain part written by hand, not stripped from the HTML, because a
 *     code email is exactly the one people read on a watch.
 *   * Dark mode left alone. Clients rewrite colours unpredictably, and a code
 *     that survives in black on white is worth more than one that looks smart
 *     in half of them.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/** Readable ink for a background, the same rule the app's card uses. */
function onColour(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Rec. 709 luma. Anything bright enough takes dark ink.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150 ? '#111111' : '#ffffff';
}

const SAFE = 'Arial, "Helvetica Neue", Helvetica, sans-serif';

/**
 * The shell every message sits in.
 *
 * `brand` is what brandFor() answers, so the venue's name, logo and colours
 * arrive the same way they do everywhere else.
 */
function layout(brand, { preheader = '', body = '', footerNote = '' }) {
  const primary = /^#[0-9a-f]{6}$/i.test(String(brand.colours?.primary)) ? brand.colours.primary : '#111111';
  const ink = onColour(primary);
  const name = esc(brand.name || 'Your card');
  const logo = brand.icon || brand.logo || null;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f0;">
<!-- The line the inbox shows beside the subject. Hidden in the message itself:
     without it clients pull the first words of the body, which on a code email
     is the code. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f0;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;">
      <tr>
        <td style="background:${primary};padding:22px 26px;" align="left">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            ${logo ? `<td style="padding-right:12px;" valign="middle">
              <img src="${esc(logo)}" width="40" height="40" alt=""
                   style="display:block;width:40px;height:40px;border-radius:9px;border:0;">
            </td>` : ''}
            <td valign="middle">
              <span style="font:700 19px/1.2 ${SAFE};color:${ink};">${name}</span>
            </td>
          </tr></table>
        </td>
      </tr>
      <tr><td style="padding:28px 26px 8px 26px;font:400 16px/1.5 ${SAFE};color:#111111;">
        ${body}
      </td></tr>
      <tr><td style="padding:18px 26px 28px 26px;font:400 13px/1.5 ${SAFE};color:#6b6b6b;">
        ${footerNote ? `<p style="margin:0 0 10px 0;">${esc(footerNote)}</p>` : ''}
        <p style="margin:0;">Sent by ${name} · powered by Vesopa</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/**
 * The sign-in code.
 *
 * The code is large, spaced and selectable, and it is ALSO in the subject line
 * — which is what lets somebody read it off a notification without opening
 * anything. That is not a leak worth worrying about: it is going to the address
 * that is being proved.
 */
function signInCode(brand, { code, minutes }) {
  const primary = /^#[0-9a-f]{6}$/i.test(String(brand.colours?.primary)) ? brand.colours.primary : '#111111';
  const html = layout(brand, {
    preheader: `Your sign-in code is ${code}. It works for ${minutes} minutes.`,
    body: `
      <p style="margin:0 0 6px 0;">Your sign-in code is</p>
      <p style="margin:0 0 6px 0;font:700 40px/1.1 ${SAFE};letter-spacing:8px;color:${primary};">${esc(code)}</p>
      <p style="margin:0 0 18px 0;color:#6b6b6b;font-size:14px;">It works for ${minutes} minutes.</p>`,
    footerNote: 'If you did not ask for this code, you can ignore this email — nobody can use it without your inbox.',
  });
  const text = `Your sign-in code for ${brand.name} is ${code}.\n\n`
    + `It works for ${minutes} minutes.\n\n`
    + 'If you did not ask for it, you can ignore this email.';
  return { html, text };
}

module.exports = { layout, signInCode, onColour, esc };
