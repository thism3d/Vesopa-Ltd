/**
 * The policy pages, rendered from the Markdown in content/policies.
 *
 * WHY THESE HAVE TO ACTUALLY RESOLVE, and not merely exist as files:
 *
 * Google, Apple, Microsoft and GitHub each fetch the privacy policy URL before
 * they will approve an OAuth application. Google in particular requires it to
 * be reachable on the same verified domain as the application, and a 404 is a
 * straight rejection — it is one of the commonest reasons a submission comes
 * back. Apple additionally requires a working account-deletion route, which
 * lives at /account/delete and is linked from these pages.
 *
 * Beyond the reviewers: the privacy policy and the cookie policy are legally
 * required of a UK company processing personal data, and the sign-in page links
 * to them from its own footer. A footer link that 404s is worse than no link.
 *
 * The pages are read from disk once and cached, because they change with a
 * deploy and not otherwise.
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const config = require('../config');

const CONTENT = path.join(__dirname, '..', '..', 'content', 'policies');

/** slug -> { title, summary, updated, html } */
let pages = null;

/**
 * Read the frontmatter block and the body.
 *
 * Deliberately small rather than a YAML library: the frontmatter here is four
 * flat `key: value` lines written by us, and a parser that can do more is a
 * parser that can be surprised by more.
 */
function parse(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { meta, body: match[2] };
}

function load() {
  if (pages && config.isProduction) return pages;

  const loaded = {};
  let files = [];
  try {
    files = fs.readdirSync(CONTENT).filter((name) => name.endsWith('.md') && name !== 'README.md');
  } catch {
    console.warn('[policies] content/policies is missing — policy pages will 404');
    pages = {};
    return pages;
  }

  for (const file of files) {
    const { meta, body } = parse(fs.readFileSync(path.join(CONTENT, file), 'utf8'));
    if (!meta.slug) continue;
    loaded[meta.slug] = {
      slug: meta.slug,
      title: meta.title || meta.slug,
      summary: meta.summary || '',
      updated: meta.updated || '',
      // The Markdown is ours, written into the repository — not user input —
      // so it is rendered as written. Nothing on these pages comes from a
      // request.
      html: marked.parse(body, { mangle: false, headerIds: true }),
    };
  }

  pages = loaded;
  return pages;
}

const router = require('express').Router();

/** The order they are listed in, and the order they make sense read in. */
const ORDER = [
  'privacy',
  'cookies',
  'terms',
  'acceptable-use',
  'data-processing',
  'retention',
  'security',
  'your-data-rights',
];

router.get('/policies', (req, res) => {
  const all = load();
  res.render('policy-index', {
    title: 'Policies',
    description: 'How Vesopa OAuth handles your data, and the terms you are agreeing to.',
    nonce: res.locals.nonce,
    config,
    policies: ORDER.map((slug) => all[slug]).filter(Boolean),
  });
});

/*
 * One route per policy, at the short slug the pages link to each other with —
 * /privacy, not /policies/privacy-policy. These URLs are given to Google, Apple
 * and Microsoft in the application registration and printed in emails, so they
 * must be short, stable, and never change again.
 */
router.get(
  ['/privacy', '/cookies', '/terms', '/acceptable-use', '/data-processing',
   '/retention', '/security', '/your-data-rights', '/gdpr', '/dpa'],
  (req, res, next) => {
    const all = load();

    // Two aliases, because the OAuth reviewers and other companies' data teams
    // look for these names, and a redirect is cheaper than a second document.
    const aliases = { gdpr: 'your-data-rights', dpa: 'data-processing' };
    const asked = req.path.slice(1);
    const slug = aliases[asked] || asked;

    const policy = all[slug];
    if (!policy) return next();

    if (aliases[asked]) return res.redirect(301, `/${slug}`);

    return res.render('policy', {
      title: policy.title,
      description: policy.summary,
      nonce: res.locals.nonce,
      config,
      policy,
    });
  },
);

module.exports = router;
module.exports.load = load;
