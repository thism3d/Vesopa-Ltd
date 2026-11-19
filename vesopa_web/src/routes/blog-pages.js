/**
 * The public blog at /blog, and the RSS feed.
 *
 * Posts are written in the admin panel. The body is sanitised here, on the way
 * out — see src/admin/sanitise.js for why that is the right end.
 */

const express = require('express');
const { pool } = require('../db');
const { sanitiseHtml, stripTags } = require('../admin/sanitise');
const { resolveLayout } = require('../blog-layouts');
const { formatDate, isoDateTime } = require('../admin/util');

const router = express.Router();

const PER_PAGE = 9;

/**
 * What counts as visible to the public.
 *
 * `published_at <= NOW()` is what makes the editor's date field a scheduling
 * control rather than decoration: a post dated next Tuesday is saved as
 * published, appears in the admin list, and stays off the site until Tuesday.
 *
 * COALESCE so a published row that somehow has no date still shows. A post the
 * admin pressed Publish on and then cannot find is a worse failure than one
 * that appears slightly early.
 */
const LIVE = `status = 'published' AND COALESCE(published_at, created_at) <= NOW()`;

/** ~220 words a minute, the usual figure for web copy. */
function readingMinutes(html) {
  const words = stripTags(html, 1e9).split(/\s+/).filter(Boolean).length;
  return words ? Math.max(1, Math.round(words / 220)) : 0;
}

// ---- Tags -----------------------------------------------------------------
//
// A tag is a page of its own at /blog/tag/<slug> (owner, 2026-11-19: Search
// Console listed 47 /blog?tag=... addresses as "Alternate page with proper
// canonical", never indexed, because each named /blog as its canonical). The
// old ?tag= links answer with a 301 to the tag's page, so Google moves them.

/** A tag's address part: "change timer" -> "change-timer", "v1.3.5.0" stays. */
function tagSlug(tag) {
  return String(tag || '').toLowerCase().trim().replace(/[^a-z0-9.]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
}

/** Every tag on a live post, by its slug: { 'change-timer': 'change timer', ... }. */
async function liveTags() {
  const [rows] = await pool.query(`SELECT tags FROM blog_posts WHERE ${LIVE} AND tags IS NOT NULL AND tags <> ''`);
  const out = {};
  for (const r of rows) {
    for (const t of String(r.tags).split(',').map((x) => x.trim()).filter(Boolean)) {
      const slug = tagSlug(t);
      if (slug && !out[slug]) out[slug] = t;
    }
  }
  return out;
}

/** The SQL that matches one whole tag in the comma list (not "epos" inside "Vesopa EPOS"). */
const TAG_MATCH = `CONCAT(',', REPLACE(REPLACE(tags, ', ', ','), ' ,', ','), ',') LIKE CONCAT('%,', ?, ',%')`;

router.use((_req, res, next) => {
  res.locals.tagSlug = tagSlug;
  next();
});

// ---- Index ----------------------------------------------------------------

router.get('/blog', (req, res, next) => {
  const tag = String(req.query.tag || '').trim().slice(0, 60);
  if (!tag) return blogIndex(req, res, next, {});
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const slug = tagSlug(tag);
  if (!slug) return res.redirect(301, '/blog');
  return res.redirect(301, `/blog/tag/${encodeURIComponent(slug)}${page > 1 ? `?page=${page}` : ''}`);
});

router.get('/blog/tag/:slug', async (req, res, next) => {
  try {
    const slug = tagSlug(req.params.slug);
    if (slug !== req.params.slug) return res.redirect(301, `/blog/tag/${encodeURIComponent(slug)}`);
    const tag = (await liveTags())[slug];
    if (!tag) return next();
    return blogIndex(req, res, next, { tag, slug });
  } catch (e) {
    return next(e);
  }
});

async function blogIndex(req, res, next, { tag = '', slug = '' }) {
  try {
    const kind = !tag && ['post', 'update'].includes(req.query.kind) ? req.query.kind : '';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

    const where = [LIVE];
    const params = [];
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (tag) { where.push(TAG_MATCH); params.push(tag); }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM blog_posts WHERE ${where.join(' AND ')}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT slug, title, kind, version, excerpt, cover_url, author, tags,
              published_at, is_featured
       FROM blog_posts
       WHERE ${where.join(' AND ')}
       ORDER BY published_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, PER_PAGE, (page - 1) * PER_PAGE]
    );

    /*
     * The lead card: the newest featured post, or failing that the newest post.
     *
     * Only on the unfiltered first page. On page 3, or under a tag, a big
     * card at the top would be showing something that is not what the reader
     * asked for — and pulling it out of `rows` would leave that page one short.
     */
    let lead = null;
    let posts = rows;
    if (page === 1 && !kind && !tag && rows.length > 2) {
      const at = rows.findIndex((p) => p.is_featured);
      lead = rows[at === -1 ? 0 : at];
      posts = rows.filter((p) => p !== lead);
    }

    const pages = Math.max(1, Math.ceil(total / PER_PAGE));

    // Each list is its own canonical: a tag's page, "Product updates", page 3.
    const base = tag ? `/blog/tag/${encodeURIComponent(slug)}` : '/blog';
    const qs = [kind && `kind=${kind}`, page > 1 && `page=${page}`].filter(Boolean).join('&');
    res.locals.ogUrl = base + (qs ? `?${qs}` : '');

    res.render('blog-index', {
      title: tag
        ? `Vesopa EPOS | #${tag}${page > 1 ? `, page ${page}` : ''}`
        : (kind === 'update' ? 'Vesopa EPOS | Product Updates' : 'Vesopa EPOS | News, Guides and Product Updates')
          + (page > 1 ? `, page ${page}` : ''),
      description: tag
        ? `Vesopa EPOS articles and product updates about ${tag}: ${total} ${total === 1 ? 'post' : 'posts'}.`
        : kind === 'update'
          ? 'Every Vesopa EPOS release, what changed in it, and why.'
          : 'Guides for running a busy till, notes on what we are building, and everything new in Vesopa EPOS.',
      posts, lead,
      kind, tag, slug, base, page, pages, total,
      formatDate, isoDateTime,
    });
  } catch (e) {
    next(e);
  }
}

// ---- Feed -----------------------------------------------------------------
//
// Before /blog/:slug, or a request for /blog/feed.xml is looked up as a post.

router.get('/blog/feed.xml', async (_req, res, next) => {
  // From res.locals, so the feed cannot advertise localhost URLs when
  // SITE_URL is unset on the server. See the note in server.js.
  const SITE_URL = res.locals.SITE_URL;
  try {
    const [rows] = await pool.query(
      `SELECT slug, title, excerpt, published_at
       FROM blog_posts WHERE ${LIVE}
       ORDER BY published_at DESC LIMIT 30`
    );

    const esc = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const items = rows
      .map(
        (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE_URL}/blog/${esc(p.slug)}</link>
      <guid isPermaLink="true">${SITE_URL}/blog/${esc(p.slug)}</guid>
      <pubDate>${new Date(p.published_at || Date.now()).toUTCString()}</pubDate>
      <description>${esc(p.excerpt)}</description>
    </item>`
      )
      .join('\n');

    res.type('application/rss+xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Vesopa EPOS</title>
    <link>${SITE_URL}/blog</link>
    <description>News, guides and product updates from Vesopa EPOS.</description>
    <language>en-GB</language>
${items}
  </channel>
</rss>
`
    );
  } catch (e) {
    next(e);
  }
});

// ---- One post -------------------------------------------------------------

router.get('/blog/:slug', async (req, res, next) => {
  try {
    const [[post]] = await pool.query(
      `SELECT * FROM blog_posts WHERE slug = ? AND ${LIVE}`,
      [String(req.params.slug).slice(0, 180)]
    );
    // Falls through to the site's 404 handler rather than rendering an empty
    // article shell.
    if (!post) return next();

    // Fire and forget: a view counter is not worth making the page wait on,
    // and a failed increment should not 500 an article that rendered fine.
    pool
      .query('UPDATE blog_posts SET views = views + 1 WHERE id = ?', [post.id])
      .catch(() => {});

    const [related] = await pool.query(
      `SELECT slug, title, cover_url, kind, published_at
       FROM blog_posts
       WHERE ${LIVE} AND id <> ? AND kind = ?
       ORDER BY published_at DESC LIMIT 3`,
      [post.id, post.kind]
    );

    res.render('blog-post', {
      title: `${post.seo_title || post.title} | Vesopa EPOS`,
      post,
      // Resolved here rather than trusted from the column, so a layout retired
      // from blog-layouts.js renders as the default instead of as a class name
      // with no CSS behind it.
      layout: resolveLayout(post.layout),
      bodyHtml: sanitiseHtml(post.body),
      readingMinutes: readingMinutes(post.body),
      description: post.seo_description || post.excerpt || stripTags(post.body, 160),
      ogImage: post.cover_url || null,
      // The headline, not the SEO title with " | Vesopa EPOS" bolted on: a
      // share card already carries the site name on its own line.
      ogTitle: post.title,
      ogImageAlt: post.title,
      ogUrl: `/blog/${post.slug}`,
      ogType: 'article',
      related,
      formatDate, isoDateTime,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = { tagSlug, liveTags, blogPagesRouter: router };
