/* The visitor's colour: "Neon on black", the same seven accents as the app
 * (vesopa_go/lib/ui/theme.dart, GoPalette.all). Load it in <head> without
 * defer, so the saved colour is in place before the page paints.
 *
 * It sets the page's --lime, --lime-hi, --on-lime and --lime-rgb, and tells
 * the 3D stage (go.js) with a "vesopa:accent" event. Where the page has the
 * site's header it adds a Colour button there, and on a first visit opens its
 * card once (after the sound welcome, if that is showing). An element with
 * data-accent-inline gets the swatches set out in it instead (the demo's
 * share page).
 *
 * The choice is kept in this browser. It is also written in the keys the
 * web demo app reads (flutter.go_accent, flutter.go_accent_asked), so where
 * the page and the demo share an address, the demo opens in the same colour
 * and does not ask again.
 */
(function () {
  var P = [
    ['lime', 'Vesopa Lime', '#A5C715', '#D4EC4A', '#10130A'],
    ['volt', 'Volt', '#C8F31D', '#DDFA6A', '#131A00'],
    ['neon', 'Neon Green', '#3EE86B', '#8AF4A4', '#03230E'],
    ['mint', 'Mint', '#2EE6A6', '#82F0CA', '#04261A'],
    ['aqua', 'Aqua', '#22D3EE', '#7FE6F5', '#032A33'],
    ['pink', 'Hot Pink', '#FF2D95', '#FF7DBE', '#2B0016'],
    ['pearl', 'Pearl', '#E8ECDF', '#FFFFFF', '#10130A']
  ];
  var KEY = 'vesopa_accent', SEEN = 'vesopa_accent_seen';
  var doc = document.documentElement;

  function find(id) {
    for (var i = 0; i < P.length; i++) if (P[i][0] === id) return P[i];
    return null;
  }
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function rgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
  }

  var current = find(get(KEY)) || P[0];

  function apply(p) {
    current = p;
    doc.style.setProperty('--lime', p[2]);
    doc.style.setProperty('--lime-hi', p[3]);
    doc.style.setProperty('--on-lime', p[4]);
    doc.style.setProperty('--lime-rgb', rgb(p[2]));
    doc.setAttribute('data-accent', p[0]);
    try { document.dispatchEvent(new CustomEvent('vesopa:accent', { detail: { id: p[0], colour: p[2] } })); } catch (e) {}
    var all = document.querySelectorAll('.acc-sw');
    for (var i = 0; i < all.length; i++) {
      var on = all[i].getAttribute('data-id') === p[0];
      all[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
    var names = document.querySelectorAll('.acc-name');
    for (var j = 0; j < names.length; j++) names[j].textContent = p[1];
  }

  function choose(p) {
    apply(p);
    put(KEY, p[0]);
    put(SEEN, '1');
    // The web demo app's own keys (shared_preferences on the web).
    put('flutter.go_accent', JSON.stringify(p[0]));
    put('flutter.go_accent_asked', 'true');
  }

  apply(current);

  var css = ''
    + '.acc-grid{display:flex;flex-wrap:wrap;gap:8px}'
    + '.acc-sw{position:relative;width:36px;height:36px;flex:none;border-radius:50%;border:0;padding:0;cursor:pointer;background:var(--c);box-shadow:0 0 16px -3px var(--c);transition:transform .2s}'
    + '.acc-sw:hover{transform:scale(1.08)}'
    + '.acc-sw:focus-visible{outline:3px solid #f2f4ec;outline-offset:3px}'
    + '.acc-sw[aria-checked="true"]{outline:2.5px solid #f2f4ec;outline-offset:3px}'
    + '.acc-sw[aria-checked="true"]::after{content:"";position:absolute;left:50%;top:46%;width:8px;height:15px;border:solid var(--o);border-width:0 3px 3px 0;transform:translate(-50%,-50%) rotate(45deg)}'
    + '.acc-btn{display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:0 14px 0 8px;border-radius:999px;border:1px solid var(--line,#2c3127);background:var(--card,#151813);color:var(--text,#f2f4ec);font:inherit;font-size:14px;cursor:pointer}'
    + '.acc-btn:hover{border-color:rgba(var(--lime-rgb),.5)}'
    + '.acc-ring{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(#A5C715 0 51deg,#C8F31D 0 103deg,#3EE86B 0 154deg,#2EE6A6 0 206deg,#22D3EE 0 257deg,#FF2D95 0 309deg,#E8ECDF 0)}'
    + '.acc-ring::after{content:"";width:12px;height:12px;border-radius:50%;background:var(--lime);border:2px solid var(--card,#151813)}'
    + '.acc-wrap{position:relative}'
    + '.acc-pop{position:absolute;right:0;top:calc(100% + 12px);z-index:70;width:min(340px,calc(100vw - 32px));background:rgba(21,24,19,.97);border:1px solid var(--line,#2c3127);border-radius:20px;padding:20px;box-shadow:0 24px 60px rgba(0,0,0,.6);color:var(--text,#f2f4ec);text-align:left;opacity:0;transform:translateY(-6px);pointer-events:none;transition:opacity .25s,transform .25s}'
    + '.acc-pop.open{opacity:1;transform:none;pointer-events:auto}'
    + '.acc-pop h3{margin:0;font-size:18px;font-weight:800}'
    + '.acc-pop p{margin:2px 0 14px;font-size:13px;color:var(--muted,#a3a79a);line-height:1.45}'
    + '.acc-foot{display:flex;justify-content:space-between;align-items:center;margin-top:16px;font-size:13px;color:var(--muted,#a3a79a)}'
    + '.acc-foot b{color:var(--lime)}'
    + '.acc-ok{border:0;border-radius:10px;padding:9px 16px;font:inherit;font-weight:800;font-size:14px;background:var(--lime);color:var(--on-lime);cursor:pointer}'
    + '.acc-later{border:0;background:none;color:var(--muted,#a3a79a);font:inherit;font-size:13px;cursor:pointer;padding:6px 0}'
    + '@media (max-width:640px){.acc-btn span.t{display:none}.acc-btn{padding:0 8px}.acc-pop{position:fixed;left:16px;right:16px;top:var(--acc-top,76px);width:auto}}';

  function grid() {
    var g = document.createElement('div');
    g.className = 'acc-grid';
    g.setAttribute('role', 'radiogroup');
    g.setAttribute('aria-label', 'Colour');
    P.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'acc-sw';
      b.setAttribute('role', 'radio');
      b.setAttribute('data-id', p[0]);
      b.setAttribute('aria-label', p[1]);
      b.setAttribute('aria-checked', p === current ? 'true' : 'false');
      b.title = p[1];
      b.style.setProperty('--c', p[2]);
      b.style.setProperty('--o', p[4]);
      b.addEventListener('click', function () { choose(p); });
      g.appendChild(b);
    });
    return g;
  }

  function header(bar) {
    var wrap = document.createElement('div');
    wrap.className = 'acc-wrap';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'acc-btn';
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<i class="acc-ring" aria-hidden="true"></i><span class="t">Colour</span>';
    var pop = document.createElement('div');
    pop.className = 'acc-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose a colour');
    pop.innerHTML = '<h3>Make it yours</h3><p>Pick a colour for the website. The Vesopa Go app offers the same ones.</p>';
    pop.appendChild(grid());
    var foot = document.createElement('div');
    foot.className = 'acc-foot';
    foot.innerHTML = '<button type="button" class="acc-later">Not now</button><button type="button" class="acc-ok">Use <span class="acc-name"></span></button>';
    pop.appendChild(foot);
    wrap.appendChild(btn);
    wrap.appendChild(pop);
    var cta = bar.querySelector('.btn.primary');
    bar.insertBefore(wrap, cta || null);

    function open(v) {
      var hd = bar.closest('header');
      if (hd) pop.style.setProperty('--acc-top', Math.round(hd.getBoundingClientRect().bottom + 10) + 'px');
      pop.classList.toggle('open', v);
      btn.setAttribute('aria-expanded', v ? 'true' : 'false');
    }
    btn.addEventListener('click', function (e) { e.stopPropagation(); open(!pop.classList.contains('open')); });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    foot.querySelector('.acc-ok').addEventListener('click', function () { choose(current); open(false); });
    foot.querySelector('.acc-later').addEventListener('click', function () { put(SEEN, '1'); open(false); });
    document.addEventListener('click', function () { if (pop.classList.contains('open')) { put(SEEN, '1'); open(false); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') open(false); });
    apply(current);

    // A first visit: open the card once, after the sound welcome has gone.
    if (!get(SEEN)) {
      var tries = 0;
      (function wait() {
        var w = document.querySelector('.welcome:not(.gone)');
        if (w && tries++ < 240) return setTimeout(wait, 500);
        setTimeout(function () { if (!get(SEEN)) open(true); }, 900);
      })();
    }
  }

  function start() {
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
    var inline = document.querySelectorAll('[data-accent-inline]');
    for (var i = 0; i < inline.length; i++) inline[i].appendChild(grid());
    var bar = document.querySelector('header.top .wrap');
    if (bar && !inline.length) header(bar);
    apply(current);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
