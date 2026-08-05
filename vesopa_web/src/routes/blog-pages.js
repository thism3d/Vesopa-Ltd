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

// ---- Index ----------------------------------------------------------------

router.get('/blog', async (req, res, next) => {
  try {
    const kind = ['post', 'update'].includes(req.query.kind) ? req.query.kind : '';
    const tag = String(req.query.tag || '').trim().slice(0, 60);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

    const where = [LIVE];
    const params = [];
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (tag) { where.push('tags LIKE ?'); params.push(`%${tag}%`); }

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

    res.render('blog-index', {
      title: kind === 'update'
        ? 'Vesopa EPOS | Product Updates'
        : 'Vesopa EPOS | News, Guides and Product Updates',
      description: kind === 'update'
        ? 'Every Vesopa EPOS release, what changed in it, and why.'
        : 'Guides for running a busy till, notes on what we are building, and everything new in Vesopa EPOS.',
      posts, lead,
      kind, tag, page, pages, total,
      formatDate, isoDateTime,
    });
  } catch (e) {
    next(e);
  }
});

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

module.exports = { blogPagesRouter: router };
