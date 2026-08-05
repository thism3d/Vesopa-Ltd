/**
 * HTML allowlist for blog bodies.
 *
 * The author is a signed-in admin, so this is not the main line of defence —
 * but "trusted author" is exactly the reasoning that puts stored XSS into
 * every CMS that has ever had one. A subadmin account is one weak password
 * away from being someone else's, and a blog post renders on the public site
 * under the site's own origin, next to the cookie the admin panel authenticates
 * with. So the body is filtered on the way out.
 *
 * An allowlist rather than a blocklist: the set of things that can execute
 * script in a browser is open-ended and grows, and a blocklist is a promise to
 * keep up with it.
 *
 * No dependency. sanitize-html would do this properly, and if the blog ever
 * grows an embed feature it should be swapped in — but for a paragraph, a
 * heading, a link and an image, 80 lines beats a 40-package tree.
 */

/*
 * `style` is allowed on most of these, which is a deliberate reversal.
 *
 * The editor used to offer only the tags listed here, on the argument that a
 * toolbar button whose output gets stripped is worse than no button. That
 * argument was right about the failure mode and wrong about the fix: the
 * answer to "the colour picker's output gets discarded" is a sanitiser that
 * understands colour, not a composer with no colour picker. So the allowlist
 * now covers what a mail-composer-style editor actually produces — colour,
 * highlight, alignment, font, size, indent — and `safeStyle` below is what
 * keeps that safe.
 *
 * `span` earns its place for the same reason: with styleWithCSS enabled,
 * execCommand wraps coloured text in `<span style="color:…">` rather than the
 * ancient `<font color>`. Dropping span would drop every colour change.
 */
const STYLEABLE = ['style'];

const ALLOWED = {
  p: STYLEABLE, br: [], strong: STYLEABLE, b: STYLEABLE, em: STYLEABLE,
  i: STYLEABLE, u: STYLEABLE, s: STYLEABLE, span: STYLEABLE,
  h2: ['id', 'style'], h3: ['id', 'style'], h4: ['id', 'style'],
  ul: STYLEABLE, ol: STYLEABLE, li: STYLEABLE,
  blockquote: STYLEABLE, pre: STYLEABLE, code: STYLEABLE,
  hr: [],
  a: ['href', 'title', 'target', 'rel', 'style'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'style'],
  figure: STYLEABLE, figcaption: STYLEABLE,
  table: STYLEABLE, thead: [], tbody: [], tr: STYLEABLE,
  th: ['colspan', 'rowspan', 'style'], td: ['colspan', 'rowspan', 'style'],
};

const VOID_TAGS = new Set(['br', 'hr', 'img']);

// ---- style="" ---------------------------------------------------------------
//
// Every declaration has to match a property this list knows AND pass that
// property's own value test. Anything else is dropped silently, so a rule the
// editor cannot produce cannot survive either.
//
// The properties are the ones a composer's buttons emit and nothing more.
// Deliberately absent: position, display, z-index, width/height on blocks,
// and anything else that lets a post reposition the page furniture around it —
// a blog body is a guest on the article template, not a licence to lay it out.

/** #abc, #aabbcc, rgb()/rgba(), or a bare CSS colour keyword. */
function isColor(v) {
  return (
    /^#[0-9a-f]{3}$/i.test(v) ||
    /^#[0-9a-f]{6}$/i.test(v) ||
    /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i.test(v) ||
    /^[a-z]{3,20}$/i.test(v)
  );
}

/** A bounded length. The cap stops "font-size: 9000px" blowing the layout. */
function isLength(v) {
  const m = /^(\d{1,4}(?:\.\d{1,2})?)(px|pt|em|rem|%)$/i.exec(v);
  if (!m) return false;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'px' || unit === 'pt') return n <= 200;
  if (unit === '%') return n <= 400;
  return n <= 12;
}

/** Font stacks only: names, quotes, commas, spaces. No functions, no URLs. */
function isFontStack(v) {
  return v.length <= 120 && /^[a-z0-9 ,'"-]+$/i.test(v);
}

const ALLOWED_STYLE = {
  color: isColor,
  'background-color': isColor,
  'text-align': (v) => ['left', 'right', 'center', 'justify'].includes(v),
  'font-family': isFontStack,
  'font-size': isLength,
  'font-weight': (v) => /^(normal|bold|bolder|lighter|[1-9]00)$/.test(v),
  'font-style': (v) => /^(normal|italic|oblique)$/.test(v),
  'text-decoration': (v) => /^(none|underline|line-through|overline)( (underline|line-through|overline))*$/.test(v),
  // Indent / outdent.
  'margin-left': isLength,
  'padding-left': isLength,
};

/**
 * Rebuild a style attribute from the declarations that are recognised and
 * valid, or return null if none are.
 */
function safeStyle(value) {
  const raw = String(value || '');

  /*
   * Reject the whole attribute on sight of a construct that has no business
   * in one, rather than trying to neutralise it per-declaration.
   *
   * url() reaches the network (and `url(javascript:…)` used to execute in
   * older engines); expression() executed arbitrary JS in legacy IE; a CSS
   * comment is the classic way to smuggle a keyword past a parser that strips
   * on substring, since "colo" + a comment + "r" reassembles into "color"
   * once the comment is discarded. Backslashes are CSS escapes, the other
   * half of that same trick.
   */
  if (/url\s*\(|expression\s*\(|javascript:|[\\<>{}]|\/\*|\*\//i.test(raw)) return null;

  const kept = [];
  for (const part of raw.split(';')) {
    const at = part.indexOf(':');
    if (at === -1) continue;

    const prop = part.slice(0, at).trim().toLowerCase();
    // !important would let a post override the article stylesheet.
    const val = part.slice(at + 1).trim().replace(/\s+/g, ' ');
    if (!val || /!\s*important/i.test(val)) continue;

    const test = Object.prototype.hasOwnProperty.call(ALLOWED_STYLE, prop)
      ? ALLOWED_STYLE[prop]
      : null;
    if (test && test(val)) kept.push(`${prop}: ${val}`);
  }

  return kept.length ? kept.join('; ') : null;
}

/** http(s), site-relative and mailto/tel only — no javascript:, no data:. */
function safeUrl(value, { allowData = false } = {}) {
  const url = String(value || '').trim();
  if (!url) return null;

  // A control character or a newline inside the scheme is how "java\nscript:"
  // gets past a naive check.
  const cleaned = url.replace(/[\u0000-\u001f\u007f]/g, '');

  if (/^(https?:|mailto:|tel:)/i.test(cleaned)) return cleaned;
  if (cleaned.startsWith('/') && !cleaned.startsWith('//')) return cleaned;
  if (cleaned.startsWith('#')) return cleaned;
  if (allowData && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(cleaned)) {
    return cleaned;
  }
  return null;
}

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Rebuild the HTML from an allowlist rather than stripping what looks bad.
 *
 * Anything not recognised — a <script>, an onclick, a <style> — is not
 * "removed"; it is simply never written to the output.
 */
function sanitiseHtml(input) {
  const src = String(input || '');
  let out = '';
  const open = [];

  /*
   * Elements whose *content* has to go with them, not just their tags.
   *
   * Dropping an unknown tag but keeping its text is right for <div> and
   * <marquee> — the words are the author's and should survive. It is wrong
   * for these: the "text" inside <script> is source code, and stripping only
   * the tags turns `<script>alert(1)</script>` into the visible string
   * "alert(1)" printed in the middle of the article. Escaped, so not
   * executable, but it is still someone's JavaScript rendered as prose.
   */
  const RAW_TEXT = new Set(['script', 'style', 'noscript', 'iframe', 'template', 'xmp', 'svg', 'math']);
  let skipping = null;

  // <tag ...>, </tag>, <!-- ... -->, or text up to the next '<'.
  const pattern = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9]*)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\/?>|([^<]+)|</g;

  let match;
  while ((match = pattern.exec(src)) !== null) {
    const [full, closeTag, openTag, rawAttrs, text] = match;

    // Inside a raw-text element: swallow everything up to its closing tag.
    if (skipping) {
      if (closeTag !== undefined && closeTag.toLowerCase() === skipping) skipping = null;
      continue;
    }

    if (text !== undefined) {
      out += escapeText(text);
      continue;
    }

    // A bare '<' that starts nothing, or a comment: drop it.
    if (closeTag === undefined && openTag === undefined) {
      if (full === '<') out += '&lt;';
      continue;
    }

    if (closeTag !== undefined) {
      const tag = closeTag.toLowerCase();
      if (!(tag in ALLOWED) || VOID_TAGS.has(tag)) continue;
      // Only close a tag that is actually open, so a stray </div> in the
      // source cannot close the page's own layout.
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }

    const tag = openTag.toLowerCase();

    // Self-closing (<svg/>) never opens a region to skip, or everything after
    // it would be swallowed to the end of the document.
    if (RAW_TEXT.has(tag) && !full.endsWith('/>')) {
      skipping = tag;
      continue;
    }

    if (!(tag in ALLOWED)) continue;

    let attrs = '';
    const attrPattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let attr;
    while ((attr = attrPattern.exec(rawAttrs || '')) !== null) {
      const name = attr[1].toLowerCase();
      if (!ALLOWED[tag].includes(name)) continue;

      let value = attr[2] ?? attr[3] ?? attr[4] ?? '';

      if (name === 'href' || name === 'src') {
        const url = safeUrl(value, { allowData: name === 'src' });
        if (!url) continue;
        value = url;
      }
      if (name === 'style') {
        const css = safeStyle(value);
        // Drop the attribute entirely rather than emitting style="" — an empty
        // one is noise in the source and in the editor's HTML view.
        if (!css) continue;
        value = css;
      }
      if (name === 'target') value = '_blank';

      attrs += ` ${name}="${escapeAttr(value)}"`;
    }

    // target="_blank" without noopener gives the opened page a handle back to
    // this one through window.opener.
    if (tag === 'a' && /target="_blank"/.test(attrs) && !/\brel=/.test(attrs)) {
      attrs += ' rel="noopener noreferrer"';
    }
    if (tag === 'img' && !/\bloading=/.test(attrs)) {
      attrs += ' loading="lazy"';
    }

    if (VOID_TAGS.has(tag)) {
      out += `<${tag}${attrs}>`;
    } else {
      out += `<${tag}${attrs}>`;
      open.push(tag);
    }
  }

  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/** Plain text, for excerpts, meta descriptions and search. */
function stripTags(html, limit = 300) {
  const text = String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

module.exports = { sanitiseHtml, stripTags, safeUrl, safeStyle };
