/* /admin (src/admin_views.js): the story's text tools, photo uploads, the web
   address that follows the title, the Google preview, and "are you sure?".
   Without this script the story is a plain box of HTML and still saves. */
(function () {
  'use strict';
  var csrf = document.body.getAttribute('data-csrf') || '';

  // Buttons that delete ask first.
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-confirm]');
    if (b && !window.confirm(b.getAttribute('data-confirm'))) e.preventDefault();
  });

  // Letters left, under a box with a limit Google shows.
  document.querySelectorAll('[data-count]').forEach(function (box) {
    var max = Number(box.getAttribute('data-count'));
    var out = document.createElement('span');
    out.className = 'adm-count';
    box.insertAdjacentElement('afterend', out);
    var show = function () {
      var n = box.value.length;
      out.textContent = n + ' / ' + max + (n > max ? ': Google will shorten this' : '');
      out.classList.toggle('over', n > max);
    };
    box.addEventListener('input', show);
    show();
  });

  var form = document.querySelector('[data-editor]');
  if (!form) return;

  // ---- The story -------------------------------------------------------------------
  var rich = form.querySelector('[data-rich]');
  var html = form.querySelector('[data-html]');
  var bar = form.querySelector('.adm-toolbar');
  rich.innerHTML = html.value;
  rich.hidden = false;
  bar.hidden = false;
  html.hidden = true;
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (err) { /* older browsers */ }
  var sync = function () { html.value = rich.innerHTML; };
  rich.addEventListener('input', sync);
  form.addEventListener('submit', sync);

  // Pasting keeps the words and the simple shapes; the server tidies the rest.
  rich.addEventListener('paste', function (e) {
    var data = e.clipboardData;
    if (!data) return;
    var h = data.getData('text/html');
    var t = data.getData('text/plain');
    e.preventDefault();
    if (h) {
      var tmp = document.createElement('div');
      tmp.innerHTML = h;
      tmp.querySelectorAll('script,style,meta,link,img,svg,iframe,object').forEach(function (n) { n.remove(); });
      tmp.querySelectorAll('*').forEach(function (n) { n.removeAttribute('style'); n.removeAttribute('class'); n.removeAttribute('id'); });
      document.execCommand('insertHTML', false, tmp.innerHTML);
    } else {
      var safe = t.split(/\n{2,}/).map(function (p) {
        return '<p>' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</p>';
      }).join('');
      document.execCommand('insertHTML', false, safe);
    }
    sync();
  });

  bar.addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
  bar.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    rich.focus();
    if (b.hasAttribute('data-cmd')) document.execCommand(b.getAttribute('data-cmd'), false, null);
    else if (b.hasAttribute('data-block')) {
      var want = b.getAttribute('data-block');
      var cur = (document.queryCommandValue('formatBlock') || '').toLowerCase();
      document.execCommand('formatBlock', false, cur === want ? 'p' : want);
    } else if (b.hasAttribute('data-link')) {
      var url = window.prompt('Link to (a web address, e.g. https://www.facebook.com/...):', 'https://');
      if (url && /^(https?:\/\/|mailto:|tel:|\/)/.test(url.trim())) document.execCommand('createLink', false, url.trim());
    } else if (b.hasAttribute('data-inline-photo')) {
      pick(false, function (img) {
        var alt = (img.alt || '').replace(/"/g, '&quot;');
        rich.focus();
        document.execCommand('insertHTML', false, '<figure><img src="' + img.url + '" alt="' + alt + '" width="' + img.w + '" height="' + img.h + '"></figure><p><br></p>');
        sync();
      });
    }
    sync();
  });

  // ---- Photos ----------------------------------------------------------------------
  var list = form.querySelector('[data-photos]');
  var progress = form.querySelector('[data-progress]');
  var chooser = form.querySelector('[data-upload]');

  // A phone's photo is made at most 2400px across here first: quicker on
  // mobile data, and an iPhone's HEIC photo arrives as a JPG the site can use.
  function shrink(file) {
    if (!window.createImageBitmap || (file.size < 2.5e6 && /jpe?g|png|webp/.test(file.type))) return Promise.resolve(file);
    return createImageBitmap(file).then(function (bmp) {
      var k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k);
      c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (ok) { c.toBlob(function (b) { ok(b || file); }, 'image/jpeg', 0.88); });
    }).catch(function () { return file; });
  }
  function upload(file, done) {
    return shrink(file).then(function (small) { return send1(small, file.name, done); });
  }
  function send1(file, name, done) {
    var fd = new FormData();
    fd.append('photo', file, name.replace(/\.\w+$/, '') + '.jpg');
    return fetch('/admin/upload', { method: 'POST', body: fd, headers: { 'x-csrf-token': csrf }, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Upload failed.'); return j; }); })
      .then(done);
  }
  function card(img) {
    var li = document.createElement('li');
    li.className = 'adm-photo';
    li.setAttribute('data-name', img.name);
    li.innerHTML = '<img alt="" width="160" height="120"><input type="hidden" name="gallery">'
      + '<label class="adm-alt">Describe the photo <small>(for blind visitors and Google)</small><input maxlength="200"></label>'
      + '<span class="adm-photo-tools"></span>';
    li.querySelector('img').src = img.thumb;
    li.querySelector('input[type=hidden]').value = img.name;
    var alt = li.querySelector('label input');
    alt.name = 'alt:' + img.name;
    alt.placeholder = 'e.g. The First XV celebrate a try at The Rec';
    list.appendChild(li);
    tools();
    alt.focus();
  }
  // The first photo is the cover; the others can be made it.
  function tools() {
    list.querySelectorAll('.adm-photo').forEach(function (li, i) {
      li.querySelector('.adm-photo-tools').innerHTML = (i === 0 ? '<b class="adm-cover">Cover photo</b>' : '<button type="button" data-cover>Make cover</button>')
        + '<button type="button" data-remove>Remove</button>';
    });
  }
  list.addEventListener('click', function (e) {
    var li = e.target.closest('.adm-photo');
    if (!li) return;
    if (e.target.closest('[data-remove]')) { li.remove(); tools(); }
    if (e.target.closest('[data-cover]')) { list.prepend(li); tools(); }
  });

  function pick(multiple, each) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    input.addEventListener('change', function () { send(Array.prototype.slice.call(input.files), each); });
    input.click();
  }
  function send(files, each) {
    if (!files.length) return;
    var n = 0;
    progress.hidden = false;
    var next = function () {
      if (n >= files.length) { progress.textContent = files.length > 1 ? 'Photos added.' : 'Photo added.'; setTimeout(function () { progress.hidden = true; }, 2500); return; }
      progress.textContent = 'Uploading photo ' + (n + 1) + ' of ' + files.length + '…';
      upload(files[n], each).then(function () { n += 1; next(); }).catch(function (err) { progress.textContent = err.message; });
    };
    next();
  }
  chooser.addEventListener('change', function () {
    send(Array.prototype.slice.call(chooser.files), card);
    chooser.value = '';
  });

  // ---- The web address, and how Google shows the post ------------------------------
  var title = form.querySelector('[data-title]');
  var slug = form.querySelector('[data-slug]');
  var seo = form.querySelector('[name="seoTitle"]');
  var summary = form.querySelector('[name="summary"]');
  var slugify = function (s) {
    return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  };
  slug.addEventListener('input', function () { slug.setAttribute('data-touched', ''); slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'); snippet(); });
  title.addEventListener('input', function () { if (!slug.hasAttribute('data-touched')) slug.value = slugify(title.value); snippet(); });
  [seo, summary].forEach(function (el) { el.addEventListener('input', snippet); });
  rich.addEventListener('input', snippet);
  function snippet() {
    var desc = summary.value.trim() || rich.textContent.trim().slice(0, 157);
    form.querySelector('[data-snip-url]').textContent = 'pontardawerfc.com › news › ' + (slug.value || slugify(title.value) || '…');
    form.querySelector('[data-snip-title]').textContent = (seo.value.trim() || title.value.trim() || 'Your title') + ' | Pontardawe RFC';
    form.querySelector('[data-snip-desc]').textContent = desc.length > 158 ? desc.slice(0, 157) + '…' : desc;
  }
  snippet();

  // Leaving with changes not saved asks first.
  var dirty = false;
  form.addEventListener('input', function () { dirty = true; });
  form.addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.getAttribute('formtarget') === '_blank') return;
    dirty = false;
  });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
}());
