/**
 * Blog and product updates.
 *
 * One table for both. A release note and an article share a template, a feed
 * and a URL space; the only difference is a badge and a version string, which
 * is a column rather than a second table.
 *
 * The body is stored exactly as the admin typed it and sanitised on the way
 * out, not on the way in. Storing the filtered version would mean a later fix
 * to the allowlist could not be applied retroactively, and an over-strict rule
 * would silently destroy the author's original text.
 */

const express = require('express');
const { pool } = require('../db');
const { ownScope } = require('../admin-auth');
const { sanitiseHtml, stripTags } = require('./sanitise');
const { LAYOUTS, resolveLayout } = require('../blog-layouts');
const {
  formatDate, formatDateTime, back, readFlash, navCounts, slugify, str, int,
} = require('./util');

const router = express.Router();

/**
 * Sort orders offered on the list.
 *
 * A whitelist mapping a short key to a fixed ORDER BY fragment, never the
 * query string interpolated into SQL — a sort parameter is the classic way an
 * injection gets in, because it is the one part of a query that cannot be a
 * bound parameter.
 */
const SORTS = {
  newest: { label: 'Newest first', sql: 'COALESCE(published_at, updated_at) DESC, id DESC' },
  oldest: { label: 'Oldest first', sql: 'COALESCE(published_at, updated_at) ASC, id ASC' },
  updated: { label: 'Recently edited', sql: 'updated_at DESC' },
  title: { label: 'Title A–Z', sql: 'title ASC' },
  views: { label: 'Most read', sql: 'views DESC, id DESC' },
};

// ---- List -----------------------------------------------------------------

router.get('/blog', async (req, res, next) => {
  try {
    const status = ['draft', 'published'].includes(req.query.status) ? req.query.status : '';
    const kind = ['post', 'update'].includes(req.query.kind) ? req.query.kind : '';
    const sort = Object.prototype.hasOwnProperty.call(SORTS, req.query.sort)
      ? req.query.sort
      : 'newest';
    const q = str(req.query.q, 120);

    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (q) {
      where.push('(title LIKE ? OR slug LIKE ? OR tags LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    // A contributor sees the posts they wrote and no others.
    const mine = ownScope(req.admin);
    if (mine.sql) { where.push('owner_admin_id = ?'); params.push(...mine.params); }

    const [rows] = await pool.query(
      `SELECT id, slug, title, kind, version, status, published_at, views,
              cover_url, author, tags, updated_at, layout, is_featured
       FROM blog_posts
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${SORTS[sort].sql}`,
      params
    );

    res.render('admin/blog', {
      title: 'Blog & Updates | Vesopa Admin',
      heading: 'Blog & Updates',
      nav: 'blog',
      counts: await navCounts(),
      flash: readFlash(req),
      rows, status, kind, sort, q, sorts: SORTS,
      now: new Date(),
      formatDate, formatDateTime,
    });
  } catch (e) {
    next(e);
  }
});

// ---- Editor ---------------------------------------------------------------

/** Images from the file manager, for the cover picker and the body picker. */
function libraryImages() {
  return pool
    .query(
      `SELECT url, title FROM media_files
       WHERE category = 'image' AND is_public = 1 ORDER BY created_at DESC LIMIT 60`
    )
    .then((r) => r[0]);
}

/**
 * A DATETIME for <input type="datetime-local">, which will not accept an ISO
 * string with a Z or a timezone offset and silently renders blank if given one.
 */
function localInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

router.get('/blog/new', async (req, res, next) => {
  try {
    res.render('admin/blog-edit', {
      title: 'New post | Vesopa Admin',
      heading: 'New post',
      nav: 'blog',
      counts: await navCounts(),
      flash: readFlash(req),
      post: {
        id: null, slug: '', title: '', kind: 'post', version: '', excerpt: '',
        body: '', cover_url: '', author: req.admin.fullname, tags: '',
        seo_title: '', seo_description: '', status: 'draft', published_at: null,
        layout: 'standard', is_featured: 0, views: 0,
      },
      images: await libraryImages(),
      layouts: LAYOUTS,
      publishedInput: '',
      formatDateTime,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/blog/:id/edit', async (req, res, next) => {
  try {
    const mine = ownScope(req.admin);
    const [[post]] = await pool.query(
      `SELECT * FROM blog_posts WHERE id = ?${mine.sql}`,
      [int(req.params.id, 0), ...mine.params]
    );
    // "No longer exists" is also what somebody else's post looks like to a
    // contributor, deliberately: a different message would confirm the id is
    // real and tell them there is something there they cannot have.
    if (!post) return back(res, '/admin/blog', { err: 'That post no longer exists.' });

    post.layout = resolveLayout(post.layout);

    res.render('admin/blog-edit', {
      title: `${post.title} | Vesopa Admin`,
      heading: 'Edit post',
      nav: 'blog',
      counts: await navCounts(),
      flash: readFlash(req),
      post,
      images: await libraryImages(),
      layouts: LAYOUTS,
      publishedInput: localInput(post.published_at),
      formatDateTime,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * A datetime-local value ("2026-07-29T14:30") as a Date, or null.
 *
 * new Date() on that string is parsed as *local* time, which is what the
 * author meant — they typed the time they want it to read on the page, not a
 * UTC instant. Anything unparseable becomes null and falls back to the normal
 * publish-time behaviour rather than writing an Invalid Date into the column.
 */
function readDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The fields shared by create and update. */
function readPost(body, admin) {
  const title = str(body.title, 255);
  const kind = body.kind === 'update' ? 'update' : 'post';
  const status = body.status === 'published' ? 'published' : 'draft';
  const raw = String(body.body || '').slice(0, 200_000);

  return {
    title,
    slug: slugify(str(body.slug, 180) || title),
    kind,
    version: kind === 'update' ? str(body.version, 32) || null : null,
    // Generated from the body when the author leaves it blank, so a listing
    // card is never an empty rectangle. stripTags because the body is HTML now
    // that there is a WYSIWYG on it — an excerpt full of <p> would be worse
    // than none.
    excerpt: str(body.excerpt, 500) || stripTags(raw, 220) || null,
    body: raw,
    cover_url: str(body.cover_url, 500) || null,
    author: str(body.author, 120) || admin.fullname || admin.username,
    tags: str(body.tags, 255) || null,
    seo_title: str(body.seo_title, 255) || null,
    seo_description: str(body.seo_description, 500) || null,
    layout: resolveLayout(str(body.layout, 32)),
    is_featured: body.is_featured ? 1 : 0,
    published_at: readDateTime(body.published_at),
    status,
  };
}

router.post('/blog/new', async (req, res, next) => {
  const post = readPost(req.body, req.admin);
  if (!post.title) return back(res, '/admin/blog/new', { err: 'A post needs a title.' });

  try {
    const [result] = await pool.query(
      `INSERT INTO blog_posts
         (slug, title, kind, version, excerpt, body, cover_url, author, tags,
          seo_title, seo_description, layout, is_featured, status, published_at,
          owner_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        post.slug, post.title, post.kind, post.version, post.excerpt, post.body,
        post.cover_url, post.author, post.tags, post.seo_title, post.seo_description,
        post.layout, post.is_featured, post.status,
        // An explicit date wins — that is the point of the field, and it is how
        // a post gets back-dated or scheduled. Otherwise: now if it is going
        // live, nothing at all if it is a draft.
        post.published_at || (post.status === 'published' ? new Date() : null),
        // Who may edit it later. Not the same thing as `author`, which is a
        // byline the editor lets anyone type anything into — scoping access on
        // that would let a contributor reach somebody else's post by changing
        // a form field.
        req.admin.id,
      ]
    );

    back(res, `/admin/blog/${result.insertId}/edit`, {
      ok: post.status === 'published' ? 'Published.' : 'Saved as a draft.',
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return back(res, '/admin/blog/new', {
        err: `A post already lives at /blog/${post.slug}. Change the URL slug.`,
      });
    }
    next(e);
  }
});

router.post('/blog/:id', async (req, res, next) => {
  const id = int(req.params.id, 0);
  const post = readPost(req.body, req.admin);
  if (!post.title) return back(res, `/admin/blog/${id}/edit`, { err: 'A post needs a title.' });

  const mine = ownScope(req.admin);
  try {
    const [[before]] = await pool.query(
      `SELECT status, published_at FROM blog_posts WHERE id = ?${mine.sql}`,
      [id, ...mine.params]
    );
    if (!before) return back(res, '/admin/blog', { err: 'That post no longer exists.' });

    // The date field wins when it is filled in. Left blank, published_at is set
    // the first time the post goes live and then left alone — an edit two
    // months later must not re-date the post to today and shove it back to the
    // top of the listing.
    const publishedAt =
      post.published_at ||
      (post.status === 'published' ? before.published_at || new Date() : before.published_at);

    await pool.query(
      `UPDATE blog_posts SET
         slug = ?, title = ?, kind = ?, version = ?, excerpt = ?, body = ?,
         cover_url = ?, author = ?, tags = ?, seo_title = ?, seo_description = ?,
         layout = ?, is_featured = ?, status = ?, published_at = ?
       WHERE id = ?${mine.sql}`,
      [
        post.slug, post.title, post.kind, post.version, post.excerpt, post.body,
        post.cover_url, post.author, post.tags, post.seo_title, post.seo_description,
        post.layout, post.is_featured, post.status, publishedAt, id,
        ...mine.params,
      ]
    );

    back(res, `/admin/blog/${id}/edit`, {
      ok: post.status === 'published' ? 'Published.' : 'Saved as a draft.',
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return back(res, `/admin/blog/${id}/edit`, {
        err: `Another post already lives at /blog/${post.slug}.`,
      });
    }
    next(e);
  }
});

router.post('/blog/:id/delete', async (req, res, next) => {
  const mine = ownScope(req.admin);
  try {
    await pool.query(`DELETE FROM blog_posts WHERE id = ?${mine.sql}`, [
      int(req.params.id, 0), ...mine.params,
    ]);
    back(res, '/admin/blog', { ok: 'Post deleted.' });
  } catch (e) {
    next(e);
  }
});

/** Publish / unpublish from the list, without opening the editor. */
router.post('/blog/:id/status', async (req, res, next) => {
  const id = int(req.params.id, 0);
  const mine = ownScope(req.admin);
  try {
    const [[post]] = await pool.query(
      `SELECT status, title, published_at FROM blog_posts WHERE id = ?${mine.sql}`,
      [id, ...mine.params]
    );
    if (!post) return back(res, '/admin/blog', { err: 'That post no longer exists.' });

    const status = post.status === 'published' ? 'draft' : 'published';
    await pool.query(`UPDATE blog_posts SET status = ?, published_at = ? WHERE id = ?${mine.sql}`, [
      status,
      status === 'published' ? post.published_at || new Date() : post.published_at,
      id,
      ...mine.params,
    ]);

    back(res, '/admin/blog', {
      ok: status === 'published' ? `“${post.title}” is live.` : `“${post.title}” is back to a draft.`,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Rendered preview of the sanitised body, for the editor's preview pane.
 *
 * Deliberately not /blog/preview: that would be caught by POST /blog/:id above
 * and parsed as a post with the id "preview".
 */
router.post('/blog-preview', (req, res) => {
  res.type('text/html').send(sanitiseHtml(String(req.body.body || '').slice(0, 200_000)));
});

module.exports = { blogRouter: router };
