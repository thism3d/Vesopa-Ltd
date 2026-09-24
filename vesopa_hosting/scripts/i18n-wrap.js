/**
 * Wrap English sentences written inside EJS code in t(), so the extractor can
 * find them and somebody can translate them.
 *
 *     node scripts/i18n-wrap.js views/public/index.ejs          # show the diff
 *     node scripts/i18n-wrap.js views/public/index.ejs --write  # apply it
 *
 * WHAT IT TOUCHES, AND NOTHING ELSE. Only a quoted string INSIDE an EJS tag,
 * only when it reads like a sentence (three or more real words), and only when
 * it is not already an argument to t(), th() or tn(). That is where a page's
 * hero and its feature cards live:
 *
 *     heading: 'Email that arrives',              ->  heading: t('Email that arrives'),
 *     ['lock', 'Nobody reads your mail', '...'],  ->  ['lock', t('Nobody reads your mail'), t('...')],
 *
 * WHAT IT REFUSES TO TOUCH. A string holding markup, an interpolation, a path,
 * a class name or an icon id -- and anything inside a block marked
 * `<%# i18n-ignore %>`, which is how the decorative code sample on the home
 * page (`export default function Page()`) stays in the one language it is
 * written in.
 *
 * It prints every change and applies none of them without --write, because a
 * regex rewriting somebody's templates should be read before it is believed.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const targets = args.filter((a) => !a.startsWith('--'));
const WRITE = args.includes('--write');

const KEEP = new Set([
  'vesopa', 'wordpress', 'ssl', 'dns', 'nvme', 'uk', 'gb', 'mb', 'tb', 'ip',
  'imap', 'smtp', 'spf', 'dkim', 'dmarc', 'whois', 'cname', 'srv', 'aaaa',
  'php', 'mysql', 'ftp', 'sftp', 'ssh', 'api', 'html', 'css', 'json', 'url',
  'sslcommerz', 'stripe', 'paypal', 'hestia',
]);

function isProse(text) {
  const words = text.match(/[A-Za-z][A-Za-z'’-]+/g) || [];
  return words.filter((w) => w.length > 2 && !KEEP.has(w.toLowerCase())).length >= 3;
}

function wrapFile(rel) {
  const file = path.join(ROOT, rel);
  const source = fs.readFileSync(file, 'utf8');
  const changes = [];

  const out = source.replace(/<%[^#][\s\S]*?%>/g, (tag) => {
    if (tag.includes('i18n-ignore')) return tag;

    return tag.replace(/(^|[^A-Za-z0-9_$.])(['"])((?:(?!\2)[^\n\\]|\\.){6,})\2/g,
      (whole, before, quote, text, offset) => {
        /*
         * Already a translator's argument?
         *
         * This has to look at everything to the LEFT of the quote inside the
         * tag, not at the one character the pattern captured: with a single
         * character the test sees "(" and passes, and the first run of this
         * happily proposed wrapping t('Billed monthly.') a second time.
         */
        const upto = tag.slice(0, offset + before.length);
        if (/\b(?:t|th|tn)\s*\(\s*$/.test(upto)) return whole;
        if (text.includes('<') || text.includes('${') || text.includes('%>')) return whole;
        if (/^[a-z0-9_./-]+$/i.test(text)) return whole;
        if (/^https?:|^\//.test(text)) return whole;
        if (!isProse(text)) return whole;
        changes.push(text);
        // Single quotes inside the text would close the literal.
        const safe = text.replace(/'/g, "\\'");
        return `${before}t('${safe}')`;
      });
  });

  return { file, rel, source, out, changes };
}

let total = 0;
for (const rel of targets) {
  const r = wrapFile(rel);
  console.log(`\n${r.rel}  (${r.changes.length})`);
  for (const c of r.changes) console.log('   +', c.slice(0, 92));
  total += r.changes.length;
  if (WRITE && r.out !== r.source) fs.writeFileSync(r.file, r.out);
}
console.log(`\n${total} string(s) ${WRITE ? 'wrapped' : 'would be wrapped'}.`);
