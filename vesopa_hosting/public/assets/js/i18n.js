/*
 * VT — the browser half of src/i18n.
 *
 * A script writes what it shows in English, VT.t('Copied'), exactly as the
 * server-side templates do. On a Bangla page /i18n/bn.js has already put the
 * table on window.VESOPA_I18N (src/i18n/bn/client.json); on an English page
 * there is no table and every call hands the English straight back.
 *
 *   VT.t('Saved {name}', { name: n })       plain text, for textContent
 *   VT.tn('{n} file', '{n} files', count)    one and many
 *   VT.num(1234)                             digits in the page's numerals
 *   VT.locale                                'en' or 'bn'
 */
(function () {
  var data = window.VESOPA_I18N || { locale: 'en', messages: {} };
  var messages = data.messages || {};
  var locale = data.locale || 'en';
  // The numerals come WITH the table (src/i18n clientPayload), so a language
  // added to LOCALES never needs an edit here.
  var numerals = data.digits || null;

  function norm(s) {
    return String(s).replace(/\s+/g, ' ').trim();
  }

  function num(value) {
    var s = String(value);
    if (!numerals) return s;
    return s.replace(/[0-9]/g, function (d) { return numerals.charAt(Number(d)); });
  }

  function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, function (whole, name) {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole;
      var v = vars[name];
      return typeof v === 'number' ? num(v) : String(v == null ? '' : v);
    });
  }

  function lookup(key) {
    if (locale === 'en') return key;
    var found = messages[norm(key)];
    return typeof found === 'string' ? found : key;
  }

  window.VT = {
    locale: locale,
    t: function (key, vars) {
      return fill(lookup(key), vars);
    },
    tn: function (one, other, n, vars) {
      var all = { n: n };
      if (vars) for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) all[k] = vars[k];
      if (locale !== 'en' && typeof messages[norm(one)] === 'string') return fill(messages[norm(one)], all);
      return fill(lookup(Number(n) === 1 ? one : other), all);
    },
    num: num,
    // For Intl: the page's own formatting locale, as the server named it.
    intl: data.intl || 'en-GB',
  };
}());
