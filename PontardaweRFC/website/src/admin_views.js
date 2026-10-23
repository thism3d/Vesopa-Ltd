/**
 * The admin's pages (/admin, src/admin.js): signing in, the list of posts,
 * the editor and the editors. Plain server-rendered forms in the club's
 * colours, made for a phone first; public/js/admin.js adds the text tools,
 * photo uploads and the web address that follows the title.
 */
'use strict';

const { club } = require('./content');
const { esc, icon, ASSET_VERSION } = require('./layout');
const { nowUK } = require('./posts');

/** The categories a post can have; all but the last also show on What's On. */
const KINDS = [
  ['club', 'Club news'], ['match', 'Match'], ['event', 'Event'], ['juniors', 'Juniors'], ['food', 'Pop-up food'],
  ['lotto', 'Weekly Lotto'], ['touch', 'Touch rugby'], ['', "News only (not on What's On)"],
];

/** Draft, Scheduled or Published, with the class its badge takes. */
function stateOf(p, now = nowUK()) {
  if (p.status !== 'published') return ['Draft', 'draft'];
  if (p.publishAt > now) return ['Scheduled', 'sched'];
  return ['Published', 'live'];
}

/** "Fri 23 Oct 2026, 6:05pm" from 2026-10-23T18:05. */
function when(local) {
  const [d, t = '00:00'] = String(local).split('T');
  const day = new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const [h, m] = t.split(':').map(Number);
  return `${day}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

function shell({ title, user = null, csrf = '', body, wide = false }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#8F0000">
<title>${esc(title)} · ${esc(club.name)} admin</title>
<link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png?v=2">
<link rel="stylesheet" href="/css/site.css?v=${ASSET_VERSION}">
<link rel="stylesheet" href="/css/admin.css?v=${ASSET_VERSION}">
</head>
<body class="adm"${csrf ? ` data-csrf="${esc(csrf)}"` : ''}>
<header class="adm-bar">
  <a class="adm-brand" href="${user ? '/admin' : '/'}"><img src="/img/crest-128.webp" alt="" width="36" height="36"><span>${esc(club.short_name || 'Pontardawe RFC')} <b>News admin</b></span></a>
  ${user ? `<nav class="adm-nav" aria-label="Admin">
    <a href="/admin">Posts</a>
    <a href="/admin/posts/new" class="adm-new">${icon('star', { size: 16 })} New post</a>
    <details class="adm-me"><summary>${esc(user.name)}</summary><div>
      <a href="/admin/account">Change password</a>
      ${user.role === 'owner' ? '<a href="/admin/editors">Editors</a>' : ''}
      <a href="/" target="_blank" rel="noopener">View the site</a>
      <form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit">Sign out</button></form>
    </div></details>
  </nav>` : ''}
</header>
<main class="adm-main${wide ? ' adm-wide' : ''}">
${body}
</main>
${user ? `<script src="/js/admin.js?v=${ASSET_VERSION}" defer></script>` : ''}
</body>
</html>`;
}

const note = (flash) => (flash ? `<p class="adm-flash" role="status">${esc(flash)}</p>` : '');
const problem = (error) => (error ? `<p class="adm-error" role="alert">${esc(error)}</p>` : '');

// ---- Signing in ----------------------------------------------------------------------

function loginPage({ error = '', email = '', next = '/admin', flash = '' } = {}) {
  return shell({
    title: 'Sign in',
    body: `<section class="adm-card adm-narrow">
  <h1>Sign in</h1>
  <p class="muted">To write and publish the club's news.</p>
  ${note(flash)}${problem(error)}
  <form method="post" action="/admin/login" class="adm-form">
    <input type="hidden" name="next" value="${esc(next)}">
    <label>Email address<input type="email" name="email" value="${esc(email)}" autocomplete="username" required autofocus></label>
    <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn btn-glow" type="submit">Sign in</button>
  </form>
  <p class="muted small">Forgotten your password? Ask the club's owner login to set a new one under Editors.</p>
</section>`,
  });
}

function setupPage({ error = '', form = {} } = {}) {
  return shell({
    title: 'Set up',
    body: `<section class="adm-card adm-narrow">
  <h1>Make the first login</h1>
  <p class="muted">This is done once. Use the setup code you were given with the site; after this, the page closes and more people are added from <b>Editors</b>.</p>
  ${problem(error)}
  <form method="post" action="/admin/setup" class="adm-form">
    <label>Setup code<input name="code" autocomplete="off" required></label>
    <label>Your name<input name="name" value="${esc(form.name || '')}" autocomplete="name" required></label>
    <label>Email address<input type="email" name="email" value="${esc(form.email || '')}" autocomplete="username" required></label>
    <label>Password <small>(at least 10 characters)</small><input type="password" name="password" minlength="10" autocomplete="new-password" required></label>
    <button class="btn btn-glow" type="submit">Create login</button>
  </form>
</section>`,
  });
}

// ---- The posts -----------------------------------------------------------------------

function listPage({ user, csrf, posts, q = '', show = 'all', flash = '' }) {
  const now = nowUK();
  const counts = { all: posts.length, live: 0, sched: 0, draft: 0 };
  posts.forEach((p) => { counts[stateOf(p, now)[1]] += 1; });
  const needle = q.trim().toLowerCase();
  const list = posts.filter((p) => (show === 'all' || stateOf(p, now)[1] === show)
    && (!needle || `${p.title} ${p.summary}`.toLowerCase().includes(needle)));
  const tab = (k, label) => `<a href="/admin?show=${k}${q ? `&q=${encodeURIComponent(q)}` : ''}" class="${show === k ? 'on' : ''}" ${show === k ? 'aria-current="page"' : ''}>${label} <span>${counts[k]}</span></a>`;
  return shell({
    title: 'Posts',
    user,
    csrf,
    body: `<div class="adm-head"><h1>News posts</h1><a class="btn btn-glow" href="/admin/posts/new">+ New post</a></div>
${note(flash)}
<form class="adm-search" method="get" action="/admin" role="search">
  <input type="hidden" name="show" value="${esc(show)}">
  <input type="search" name="q" value="${esc(q)}" placeholder="Search posts" aria-label="Search posts">
</form>
<nav class="adm-tabs" aria-label="Show">${tab('all', 'All')}${tab('live', 'Published')}${tab('sched', 'Scheduled')}${tab('draft', 'Drafts')}</nav>
${list.length ? `<ul class="adm-posts">${list.map((p) => {
      const [state, cls] = stateOf(p, now);
      const thumb = p.image ? `<img src="/img/${esc(p.image)}${p.image.startsWith('u/') || p.image.startsWith('ig/') ? '-480' : ''}.webp" alt="" width="72" height="72" loading="lazy">` : '<span class="adm-noimg" aria-hidden="true"></span>';
      return `<li><a href="/admin/posts/${esc(p.id)}">${thumb}<span class="adm-pt"><b>${esc(p.title)}</b><small><span class="adm-badge adm-${cls}">${state}</span> ${esc(when(p.publishAt))}${p.kind ? ` · ${esc((KINDS.find((k) => k[0] === p.kind) || KINDS[0])[1])}` : ''}</small></span></a></li>`;
    }).join('')}</ul>` : `<p class="adm-empty">${needle ? 'No posts match that search.' : 'No posts here yet.'} <a href="/admin/posts/new">Write one</a>.</p>`}`,
  });
}

function photoCard(name, meta, i) {
  const small = name.startsWith('u/') || name.startsWith('ig/');
  return `<li class="adm-photo" data-name="${esc(name)}">
  <img src="/img/${esc(name)}${small ? '-480' : ''}.webp" alt="" width="160" height="120" loading="lazy">
  <input type="hidden" name="gallery" value="${esc(name)}">
  <label class="adm-alt">Describe the photo <small>(for blind visitors and Google)</small><input name="alt:${esc(name)}" value="${esc((meta && meta.alt) || '')}" maxlength="200"></label>
  <span class="adm-photo-tools">${i === 0 ? '<b class="adm-cover">Cover photo</b>' : '<button type="button" data-cover>Make cover</button>'}<button type="button" data-remove>Remove</button></span>
</li>`;
}

function editorPage({ user, csrf, post = null, images = {}, error = '', flash = '', form = null }) {
  const p = form || post || {};
  const isNew = !post;
  const now = nowUK();
  const [state, cls] = post ? stateOf(post, now) : ['New', 'draft'];
  const [pubDay, pubTime] = String(p.publishAt || now).split('T');
  const ev = p.event || {};
  const [evDay = '', evTime = ''] = ev.start ? String(ev.start).split('T') : [];
  const gallery = (p.gallery && p.gallery.length ? p.gallery : (p.image ? [p.image] : []));
  const live = post && cls === 'live';
  return shell({
    title: isNew ? 'New post' : `Edit: ${p.title}`,
    user,
    csrf,
    wide: true,
    body: `<div class="adm-head"><div><a class="adm-back" href="/admin">← All posts</a><h1>${isNew ? 'New post' : 'Edit post'}</h1></div>${post ? `<span class="adm-badge adm-${cls}">${state}</span>` : ''}</div>
${note(flash)}${problem(error)}
<form method="post" action="${isNew ? '/admin/posts' : `/admin/posts/${esc(post.id)}`}" class="adm-form adm-editor" data-editor>
<input type="hidden" name="_csrf" value="${esc(csrf)}">
${post ? `<input type="hidden" name="id" value="${esc(post.id)}">` : ''}
<div class="adm-cols">
<div class="adm-maincol">
  <label class="adm-title">Title<input name="title" value="${esc(p.title || '')}" maxlength="140" required data-title placeholder="e.g. Home win against Penlan"></label>

  <div class="adm-field">
    <span class="adm-label" id="body-label">Story</span>
    <div class="adm-toolbar" role="toolbar" aria-label="Text tools" hidden>
      <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
      <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
      <button type="button" data-block="h2" title="Heading">H</button>
      <button type="button" data-block="h3" title="Small heading">h</button>
      <button type="button" data-cmd="insertUnorderedList" title="Bullet list">• List</button>
      <button type="button" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
      <button type="button" data-block="blockquote" title="Quote">“ ”</button>
      <button type="button" data-link title="Link">Link</button>
      <button type="button" data-inline-photo title="Photo in the story">Photo</button>
      <button type="button" data-cmd="undo" title="Undo">↶</button>
      <button type="button" data-cmd="redo" title="Redo">↷</button>
    </div>
    <div class="adm-rich article-text" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="body-label" data-rich hidden></div>
    <textarea name="html" rows="14" data-html aria-labelledby="body-label">${esc(p.html || '')}</textarea>
  </div>

  <label>Summary <small>(shown on the news cards and in Google; left empty, the start of the story is used)</small>
    <textarea name="summary" rows="3" maxlength="300" data-count="160">${esc(p.summary || '')}</textarea></label>

  <fieldset class="adm-field">
    <legend>Photos <small>(the first is the cover, on the cards and at the top)</small></legend>
    <ul class="adm-photos" data-photos>${gallery.map((n, i) => photoCard(n, images[n], i)).join('')}</ul>
    <label class="btn btn-line adm-upload">+ Add photos<input type="file" accept="image/*" multiple data-upload hidden></label>
    <p class="adm-progress" data-progress hidden></p>
  </fieldset>
</div>

<aside class="adm-side">
  <section class="adm-card">
    <h2>Publish</h2>
    <label>Date<input type="date" name="pub_day" value="${esc(pubDay)}" required></label>
    <label>Time<input type="time" name="pub_time" value="${esc(String(pubTime || '09:00').slice(0, 5))}" required></label>
    <p class="muted small">A date and time still to come schedules the post: it appears by itself then.</p>
    <div class="adm-actions">
      <button class="btn btn-glow" type="submit" name="action" value="publish">${live ? 'Update' : 'Publish'}</button>
      <button class="btn btn-line" type="submit" name="action" value="draft">${live ? 'Unpublish (draft)' : 'Save draft'}</button>
      <button class="btn btn-line" type="submit" formaction="/admin/preview" formtarget="_blank" name="action" value="preview">Preview</button>
    </div>
    ${live ? `<p class="small"><a href="/news/${esc(post.slug)}" target="_blank" rel="noopener">View on the site ↗</a></p>` : ''}
  </section>

  <section class="adm-card">
    <h2>Category</h2>
    <label class="adm-sr" for="kind">Category</label>
    <select id="kind" name="kind">${KINDS.map(([k, label]) => `<option value="${k}"${(p.kind ?? 'club') === k ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
  </section>

  <details class="adm-card"${ev.start ? ' open' : ''}>
    <summary><h2>Event or match date</h2></summary>
    <p class="muted small">Fill this in for something coming up: it shows on What's On and on the home page until the day has passed.</p>
    <label>Day<input type="date" name="ev_day" value="${esc(evDay)}"></label>
    <label>Time<input type="time" name="ev_time" value="${esc(evTime.slice(0, 5))}"></label>
    <label>Where<input name="ev_place" value="${esc(ev.place || '')}" placeholder="${esc(club.address.name)}"></label>
    <label>Price<input name="ev_price" value="${esc(ev.price || '')}" placeholder="e.g. £5 on the gate"></label>
    <label>Note<input name="ev_note" value="${esc(ev.note || '')}" placeholder="e.g. Bar open from noon"></label>
  </details>

  <details class="adm-card"${p.cta ? ' open' : ''}>
    <summary><h2>Button</h2></summary>
    <p class="muted small">Optional: a button at the end of the post, e.g. to book or buy.</p>
    <label>Words on the button<input name="cta_label" value="${esc((p.cta && p.cta.label) || '')}" maxlength="60"></label>
    <label>Link<input type="url" name="cta_href" value="${esc((p.cta && p.cta.href) || '')}" placeholder="https://"></label>
  </details>

  <details class="adm-card">
    <summary><h2>Google and sharing</h2></summary>
    <label>Web address<span class="adm-slug">pontardawerfc.com/news/<input name="slug" value="${esc(p.slug || '')}" data-slug${p.slug ? ' data-touched' : ''} maxlength="80" autocapitalize="off" spellcheck="false"></span></label>
    <label>Title in Google <small>(optional, up to 60 letters)</small><input name="seoTitle" value="${esc(p.seoTitle || '')}" maxlength="70" data-count="60"></label>
    <div class="adm-snippet" aria-hidden="true"><span data-snip-url></span><b data-snip-title></b><span data-snip-desc></span></div>
  </details>

  ${post ? `<section class="adm-card adm-danger">
    <h2>Delete</h2>
    <p class="muted small">Takes the post off the site for good.</p>
    <button class="btn btn-line" type="submit" formaction="/admin/posts/${esc(post.id)}/delete" formnovalidate data-confirm="Delete “${esc(p.title)}”? This cannot be undone.">Delete post</button>
  </section>` : ''}
</aside>
</div>
</form>`,
  });
}

// ---- People ----------------------------------------------------------------------

function editorsPage({ user, csrf, users, error = '', flash = '', form = {} }) {
  return shell({
    title: 'Editors',
    user,
    csrf,
    body: `<div class="adm-head"><h1>Editors</h1></div>
<p class="muted">Everyone here can write, publish and delete news. Owners can also add and remove editors.</p>
${note(flash)}${problem(error)}
<ul class="adm-users">${users.map((u) => `<li><span><b>${esc(u.name)}</b> <small>${esc(u.email)} · ${u.role === 'owner' ? 'Owner' : 'Editor'}</small></span>
  <span class="adm-user-tools">
  <details><summary>New password</summary><form method="post" action="/admin/editors/${esc(u.id)}/password" class="adm-inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="password" name="password" minlength="10" required placeholder="At least 10 characters" autocomplete="new-password"><button class="btn btn-line" type="submit">Set</button></form></details>
  ${u.id !== user.id ? `<form method="post" action="/admin/editors/${esc(u.id)}/delete"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn btn-line" type="submit" data-confirm="Remove ${esc(u.name)}'s login?">Remove</button></form>` : ''}
  </span></li>`).join('')}</ul>
<section class="adm-card adm-narrow">
  <h2>Add someone</h2>
  <form method="post" action="/admin/editors" class="adm-form">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <label>Name<input name="name" value="${esc(form.name || '')}" required></label>
    <label>Email address<input type="email" name="email" value="${esc(form.email || '')}" required autocomplete="off"></label>
    <label>Password to give them <small>(at least 10 characters; they can change it)</small><input type="password" name="password" minlength="10" required autocomplete="new-password"></label>
    <label>Can they add other editors?<select name="role"><option value="editor">No: Editor</option><option value="owner">Yes: Owner</option></select></label>
    <button class="btn btn-glow" type="submit">Add</button>
  </form>
</section>`,
  });
}

function accountPage({ user, csrf, error = '', flash = '' }) {
  return shell({
    title: 'Your password',
    user,
    csrf,
    body: `<section class="adm-card adm-narrow">
  <h1>Change your password</h1>
  ${note(flash)}${problem(error)}
  <form method="post" action="/admin/account" class="adm-form">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <input type="email" name="email" value="${esc(user.email)}" autocomplete="username" hidden>
    <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
    <label>New password <small>(at least 10 characters)</small><input type="password" name="password" minlength="10" autocomplete="new-password" required></label>
    <button class="btn btn-glow" type="submit">Change password</button>
  </form>
  <p class="muted small">This signs you out on your other devices.</p>
</section>`,
  });
}

module.exports = { loginPage, setupPage, listPage, editorPage, editorsPage, accountPage, KINDS };
