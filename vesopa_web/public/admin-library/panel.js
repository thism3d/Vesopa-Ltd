/**
 * Admin panel behaviour.
 *
 * Everything is delegated off `document` and driven by data attributes, so a
 * screen adds a confirm dialog or a copy button by writing an attribute rather
 * than by shipping its own inline script. The PHP panel put an onclick on every
 * destructive button with the record's name interpolated into it, which meant a
 * business called O'Neill's broke the handler.
 */
(function () {
  'use strict';

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // ---- Sidebar drawer ------------------------------------------------------

  var side = document.getElementById('apSide');
  var scrim = document.getElementById('apScrim');
  var burger = document.getElementById('apBurger');

  function closeDrawer() {
    if (!side) return;
    side.classList.remove('is-open');
    if (scrim) scrim.hidden = true;
  }

  if (burger && side) {
    burger.addEventListener('click', function () {
      var open = side.classList.toggle('is-open');
      if (scrim) scrim.hidden = !open;
    });
  }
  if (scrim) scrim.addEventListener('click', closeDrawer);

  // A drawer left open across a resize back to desktop leaves the scrim
  // covering a layout that no longer needs it.
  window.addEventListener('resize', function () {
    if (window.innerWidth > 860) closeDrawer();
  });

  // ---- Modal ---------------------------------------------------------------

  var modal = document.getElementById('apModal');
  var modalBox = document.getElementById('apModalBox');

  function openModal(html) {
    if (!modal) return;
    modalBox.innerHTML = html;
    modal.hidden = false;
    var first = modalBox.querySelector('input:not([type=hidden]), select, textarea');
    if (first) first.focus();
  }
  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    modalBox.innerHTML = '';
  }

  window.apModal = openModal;
  window.apCloseModal = closeModal;

  if (modal) {
    modal.addEventListener('click', function (e) {
      if (e.target === modal || e.target.closest('[data-modal-close]')) closeModal();
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal(); closeDrawer(); }
  });

  // ---- Confirm before submitting ------------------------------------------
  //
  // <button data-confirm="Delete this?"> inside a form. The dialog owns the
  // submit; the original click is always cancelled.

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-confirm]');
    if (!btn) return;

    var form = btn.form || btn.closest('form');
    if (!form) return;

    e.preventDefault();

    openModal(
      '<h3>Please confirm</h3>' +
      '<p class="ap-card-sub">' + esc(btn.getAttribute('data-confirm')) + '</p>' +
      '<div class="ap-btn-row" style="justify-content:flex-end">' +
        '<button class="ap-btn ghost" type="button" data-modal-close>Cancel</button>' +
        '<button class="ap-btn danger" type="button" id="apConfirmYes">Yes, continue</button>' +
      '</div>'
    );

    document.getElementById('apConfirmYes').addEventListener('click', function () {
      closeModal();
      /*
       * requestSubmit(btn), not submit().
       *
       * form.submit() skips validation *and* drops the submitter, so a button
       * carrying formaction="…/delete" or name="status" value="published"
       * would post to the form's own action with that value missing — the
       * delete would silently become a save.
       */
      if (form.requestSubmit) {
        form.requestSubmit(btn.type === 'submit' ? btn : undefined);
      } else {
        form.submit();
      }
    }, { once: true });
  });

  // ---- Inline modal forms --------------------------------------------------
  //
  // <button data-modal-template="tplId"> opens the contents of a <template>.
  // Values can be seeded from the button: data-set-name="value".

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-modal-template]');
    if (!btn) return;

    var tpl = document.getElementById(btn.getAttribute('data-modal-template'));
    if (!tpl) return;

    openModal(tpl.innerHTML);

    Array.prototype.forEach.call(btn.attributes, function (attr) {
      if (attr.name.indexOf('data-set-') !== 0) return;
      var field = modalBox.querySelector('[name="' + attr.name.slice(9) + '"]');
      if (!field) return;
      if (field.type === 'checkbox') field.checked = attr.value === '1';
      else field.value = attr.value;
    });

    // Screens that need to react to which row opened the dialog.
    var title = btn.getAttribute('data-modal-title');
    if (title) {
      var h = modalBox.querySelector('h3');
      if (h) h.textContent = title;
    }

    // One <template> reused for every row means the form's action has to be
    // built from the id the button seeded, rather than baked into the markup.
    Array.prototype.forEach.call(modalBox.querySelectorAll('[data-id-action]'), function (form) {
      var idField = form.querySelector('[name="id"]');
      if (!idField || !idField.value) return;
      form.setAttribute(
        'action',
        form.getAttribute('data-id-action') + idField.value + (form.getAttribute('data-id-suffix') || '')
      );
    });
  });

  // ---- Copy to clipboard ---------------------------------------------------

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;

    var text = btn.getAttribute('data-copy');
    // Absolute, so what lands in the paste buffer is a link that works in an
    // email rather than "/app/installer.exe".
    if (text.charAt(0) === '/') text = window.location.origin + text;

    var done = function () {
      var icon = btn.querySelector('.material-icons');
      if (!icon) return;
      var was = icon.textContent;
      icon.textContent = 'check';
      setTimeout(function () { icon.textContent = was; }, 1400);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done);
    } else {
      // http://localhost during development has no clipboard API.
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { /* nothing to do */ }
      document.body.removeChild(ta);
    }
  });

  // ---- Slug from title -----------------------------------------------------
  //
  // Only until the slug is touched by hand — retitling a published post must
  // not silently change its URL.

  document.addEventListener('input', function (e) {
    var src = e.target.closest('[data-slug-source]');
    if (!src) return;

    var target = document.querySelector('[name="' + src.getAttribute('data-slug-source') + '"]');
    if (!target || target.dataset.touched === '1') return;

    target.value = src.value
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 160);
  });

  document.addEventListener('input', function (e) {
    if (e.target.matches('[data-slug-target]')) e.target.dataset.touched = '1';
  });

  // ---- Auto-submit filters -------------------------------------------------

  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-autosubmit]');
    if (el && el.form) el.form.submit();
  });

  // ---- Upload drop zone ----------------------------------------------------

  var drop = document.querySelector('[data-drop]');
  if (drop) {
    var input = document.getElementById(drop.getAttribute('data-drop'));

    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.remove('is-over');
      });
    });

    drop.addEventListener('drop', function (e) {
      if (!input || !e.dataTransfer.files.length) return;
      input.files = e.dataTransfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    if (input) {
      input.addEventListener('change', function () {
        var label = drop.querySelector('[data-drop-label]');
        if (!label) return;
        label.textContent = input.files.length
          ? input.files[0].name + ' — ready to upload'
          : label.getAttribute('data-default') || 'Drop a file here';
      });
    }
  }

  // ---- Password change (the one screen that talks JSON) --------------------

  var pwForm = document.getElementById('apPasswordForm');
  if (pwForm) {
    pwForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var out = document.getElementById('apPasswordResult');

      fetch(pwForm.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(pwForm)),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.status === 'SUCCESS') {
            out.className = 'ap-flash ok';
            out.textContent = 'Password changed. Signing you out…';
            setTimeout(function () { window.location.href = '/admin'; }, 1200);
          } else {
            out.className = 'ap-flash err';
            out.textContent = data.message || 'That did not work. Check the current password.';
          }
        })
        .catch(function () {
          out.className = 'ap-flash err';
          out.textContent = 'Could not reach the server.';
        });
    });
  }
})();
