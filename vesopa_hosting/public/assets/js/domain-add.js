/**
 * The add-domain form, explaining itself as you type.
 *
 * This decides NOTHING. The server works out whether a name is a domain or a
 * subdomain (linking.findParent) and ignores anything posted that does not
 * apply — a subdomain never gets a DNS zone or a mail domain whatever arrives
 * in the body. All this does is say, before the customer commits, which of the
 * two things they are about to create, so the form stops asking questions that
 * do not apply to it.
 *
 * With JavaScript off the form is simply the form, and everything still works.
 */
(function () {
  'use strict';

  var form = document.getElementById('add-form');
  if (!form) return;

  var input = document.getElementById('domain');
  var detect = document.getElementById('detect');
  var detectIcon = document.getElementById('detect-icon');
  var detectText = document.getElementById('detect-text');
  var domainOnly = document.getElementById('domain-only');
  var asideDomain = document.getElementById('aside-domain');
  var submit = document.getElementById('add-submit');

  var parents = (form.dataset.parents || '')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);

  /** People paste URLs. Take the name out of one rather than complain about it. */
  function clean(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[/?#].*$/, '')
      .replace(/\.$/, '');
  }

  /**
   * Which domain on the account does this name sit under?
   *
   * The same rule the server uses, and deliberately NOT a count of dots:
   * `shop.heat6.com` and `vesopa.co.uk` both have three labels, one is a
   * subdomain and one is a registrable domain, and nothing but the account's
   * own list of domains tells them apart.
   */
  function parentOf(name) {
    for (var i = 0; i < parents.length; i++) {
      if (name.length > parents[i].length + 1 &&
          name.slice(-(parents[i].length + 1)) === '.' + parents[i]) {
        return parents[i];
      }
    }
    return null;
  }

  var TICK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

  function show(kind, html) {
    detect.hidden = false;
    detect.className = 'detect is-' + kind;
    detectIcon.innerHTML = TICK;
    detectText.innerHTML = html;
  }

  function update() {
    var name = clean(input.value);

    if (!name || name.indexOf('.') < 0) {
      detect.hidden = true;
      domainOnly.hidden = false;
      if (asideDomain) asideDomain.hidden = false;
      if (submit) submit.textContent = 'Add it';
      return;
    }

    var parent = parentOf(name);

    if (parent) {
      // A subdomain: nothing to ask, nothing to wait for.
      show('sub', 'A <b>subdomain</b> of <span class="mono">' + parent + '</span>. ' +
        'It will be set up straight away, with its own folder and certificate. ' +
        'No DNS zone and no mailboxes of its own.');
      domainOnly.hidden = true;
      if (asideDomain) asideDomain.hidden = true;
      if (submit) submit.textContent = 'Add this subdomain';
    } else {
      show('dom', 'A <b>domain</b>. You will point it at us with our nameservers, ' +
        'or with an A record if you would rather keep DNS where it is.');
      domainOnly.hidden = false;
      if (asideDomain) asideDomain.hidden = false;
      if (submit) submit.textContent = 'Add this domain';
    }
  }

  input.addEventListener('input', update);
  input.addEventListener('blur', function () {
    // Normalise what they actually see, so a pasted URL does not sit in the box
    // looking like it is about to be submitted as-is.
    var cleaned = clean(input.value);
    if (cleaned && cleaned !== input.value) input.value = cleaned;
    update();
  });

  update();
})();
