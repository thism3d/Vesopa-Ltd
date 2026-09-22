/**
 * The page for an address that is not a page — on any of the public hosts
 * this process serves (menu.vesopa.com, loyalty.vesopa.com, a venue's own
 * domain).
 *
 * It used to be a bare "Not found" in a monospace font, or one unstyled
 * sentence. A customer who mistyped the venue on a table card, or followed a
 * stale link, was left with nothing to press. This says what happened, in
 * the same dark Vesopa look as the pages around it, and offers the way back:
 * the home page of the host they are on, and — when the caller knows one —
 * the venue's menu.
 *
 * Self-contained: no stylesheet, no font request, no script. A 404 that
 * needs a second request to look right is a 404 that sometimes looks wrong.
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {object} o
 * @param {string} o.product   "Menu", "Loyalty" — the word beside the mark
 * @param {string} o.home      where the button goes, e.g. "/" or "https://menu.vesopa.com/"
 * @param {string} [o.homeLabel]
 * @param {string} [o.title]
 * @param {string} [o.message]
 * @param {Array<[string,string]>} [o.links]  extra links: [label, href]
 */
function notFoundPage({ product, home, homeLabel, title, message, links = [] }) {
  const heading = title || 'That page is not here';
  const body = message || 'There is nothing at this address. It may have been typed a letter out, or the link may be older than the page.';
  const extra = links.map(([label, href]) => `<a class="link" href="${esc(href)}">${esc(label)}</a>`).join('');
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(heading)} · Vesopa ${esc(product)}</title>
<style>
:root{--lime:#A5C715;--ink:#0D0D0C;--text:#F4F4EF;--muted:#B9B9B1;--line:#2A2A28}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--ink);color:var(--text);font:400 16px/1.6 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;padding:32px 20px}
.card{width:100%;max-width:520px;text-align:center}
.brand{display:inline-flex;align-items:center;gap:12px;margin-bottom:34px;text-decoration:none}
.brand img{height:22px;width:auto}.brand span{font:700 11px/1 Inter,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);border-left:1px solid var(--line);padding-left:12px}
.mark{width:64px;height:64px;border-radius:18px;margin:0 auto 22px;background:rgba(165,199,21,.12);color:var(--lime);display:grid;place-items:center}
.mark svg{width:30px;height:30px}
h1{font-size:clamp(26px,5vw,34px);line-height:1.15;letter-spacing:-.02em;margin:0 0 10px}
p{color:var(--muted);margin:0 0 26px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 22px;border-radius:12px;font-weight:700;text-decoration:none;background:var(--lime);color:#111}
.btn:hover{background:#B5D526}
.links{display:flex;flex-wrap:wrap;gap:8px 22px;justify-content:center;margin-top:18px}
.link{color:var(--muted);text-decoration:none;font-weight:600;font-size:14px}.link:hover{color:var(--text)}
</style></head>
<body><main class="card">
<a class="brand" href="${esc(home)}"><img src="/assets/vesopa_logo_on_dark.png" alt="Vesopa"><span>${esc(product)}</span></a>
<div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/></svg></div>
<h1>${esc(heading)}</h1>
<p>${esc(body)}</p>
<a class="btn" href="${esc(home)}">${esc(homeLabel || 'Back to the home page')}</a>
${extra ? `<div class="links">${extra}</div>` : ''}
</main></body></html>`;
}

module.exports = { notFoundPage };
