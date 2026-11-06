/* go.vesopa.com: the hero's 3D stage (three.js r128, js/three.min.js) and the
   page's scroll motion.

   The stage: an iPad showing the till's sale screen and an iPhone playing the
   app's own Tap to Pay film, floating in a field of lime light, with a card
   that comes down to the top of the iPhone and the contactless rings rising to
   meet it. The pointer turns the pair; scrolling tips them back and away.
   Without WebGL, or with reduced motion asked for, a still picture stands in
   (or one frame is drawn). */
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- reveal on scroll -------------------------------------------------
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -10% 0px' }) : null;
  document.querySelectorAll('.reveal').forEach(function (el, i) {
    el.style.transitionDelay = (i % 3) * 80 + 'ms';
    if (io) io.observe(el); else el.classList.add('in');
  });

  // ---- devices that turn as they pass, the screenshot rail ------------
  var tilts = Array.prototype.slice.call(document.querySelectorAll('.tilt'));
  var rail = document.getElementById('rail');
  function onScroll() {
    var vh = window.innerHeight;
    tilts.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var p = ((r.top + r.height / 2) - vh / 2) / vh; // -0.5 .. 0.5 across the screen
      el.style.transform = reduced ? '' : 'rotateX(' + (p * 14).toFixed(2) + 'deg) rotateY(' + (p * -8).toFixed(2) + 'deg) translateZ(0)';
    });
    root.classList.toggle('scrolled', window.scrollY > 40);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

  // Films play by themselves as they come on screen, and stop when they
  // leave (not at all with reduced motion). No controls, ever: if the phone
  // will not autoplay (iPhone Low Power Mode), the still frame stays.
  document.querySelectorAll('video').forEach(function (v) {
    v.muted = true;
    v.controls = false;
    if (reduced) { v.removeAttribute('autoplay'); v.pause(); return; }
    if (!io) return;
    new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { v.play().catch(function () {}); } else { v.pause(); } });
    }, { threshold: 0.25 }).observe(v);
  });

  // ---- the screenshot row: swipe, drag, or let it drift -----------------
  if (rail) {
    var held = false, seen = false, startX = 0, startLeft = 0, moved = false;
    if (io) new IntersectionObserver(function (es) { seen = es[0].isIntersecting; }).observe(rail);
    rail.addEventListener('pointerdown', function (e) {
      held = true; moved = false;
      if (e.pointerType !== 'mouse') return; // touch scrolls natively
      startX = e.clientX; startLeft = rail.scrollLeft;
      rail.classList.add('dragging');
      rail.setPointerCapture(e.pointerId);
    });
    rail.addEventListener('pointermove', function (e) {
      if (!rail.classList.contains('dragging')) return;
      var dx = e.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      rail.scrollLeft = startLeft - dx;
    });
    function release() { held = false; rail.classList.remove('dragging'); }
    rail.addEventListener('pointerup', release);
    rail.addEventListener('pointercancel', release);
    rail.addEventListener('mouseleave', function () { held = false; });
    rail.addEventListener('click', function (e) { if (moved) e.preventDefault(); }, true);
    var drift = 0.35, last = 0;
    (function tick(t) {
      if (!reduced && seen && !held && document.visibilityState === 'visible') {
        var max = rail.scrollWidth - rail.clientWidth;
        if (max > 0) {
          if (rail.scrollLeft >= max - 1) drift = -Math.abs(drift);
          if (rail.scrollLeft <= 0) drift = Math.abs(drift);
          rail.scrollLeft += drift * Math.min(2, (t - last) / 16 || 1);
        }
      }
      last = t;
      requestAnimationFrame(tick);
    })(0);
  }

  // ---- a sale, step by step: the step in the middle of the screen leads --
  var steps = Array.prototype.slice.call(document.querySelectorAll('.step'));
  var shots = Array.prototype.slice.call(document.querySelectorAll('.steps-phone .frame img'));
  var bar = document.querySelector('.steps-bar i');
  function showStep(i) {
    steps.forEach(function (s, k) { s.classList.toggle('on', k === i); });
    shots.forEach(function (s, k) { s.classList.toggle('on', k === i); });
    if (bar) bar.style.width = ((i + 1) / steps.length * 100) + '%';
  }
  if (steps.length && io) {
    var stepIo = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) showStep(Number(e.target.getAttribute('data-i'))); });
    }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach(function (s) { stepIo.observe(s); });
  } else {
    steps.forEach(function (s) { s.classList.add('on'); });
  }

  // ---- the 3D stage ----------------------------------------------------
  var canvas = document.getElementById('stage');
  window.addEventListener('load', function () { start(); });

  function start() {
    var THREE = window.THREE;
    var gl = null;
    try { gl = THREE && canvas.getContext('webgl', { antialias: true, alpha: true }); } catch (e) { gl = null; }
    if (!gl) { root.classList.add('no-webgl'); return; }

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0, 9);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    var key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(-3, 4, 6);
    scene.add(key);
    var rim = new THREE.PointLight(0xa5c715, 2.2, 14);
    rim.position.set(3, -1, 2);
    scene.add(rim);

    var loader = new THREE.TextureLoader();
    function tex(t) { t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t; }

    function roundedShape(w, h, r) {
      var s = new THREE.Shape(), x = -w / 2, y = -h / 2;
      s.moveTo(x + r, y);
      s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
      s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
      s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
      return s;
    }
    // A flat rounded rectangle with its picture stretched corner to corner.
    function screenGeometry(w, h, r) {
      var g = new THREE.ShapeGeometry(roundedShape(w, h, r), 12);
      var pos = g.attributes.position, uv = g.attributes.uv;
      for (var i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / w + 0.5, pos.getY(i) / h + 0.5);
      return g;
    }
    function device(w, h, r, depth, map) {
      var g = new THREE.Group();
      var body = new THREE.Mesh(
        new THREE.ExtrudeGeometry(roundedShape(w, h, r), { depth: depth, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 4, curveSegments: 16 }),
        new THREE.MeshStandardMaterial({ color: 0x1b1e19, metalness: 0.75, roughness: 0.32 })
      );
      body.position.z = -depth;
      g.add(body);
      var inset = Math.min(w, h) * 0.045;
      var screen = new THREE.Mesh(screenGeometry(w - inset * 2, h - inset * 2, Math.max(0.02, r - inset)), new THREE.MeshBasicMaterial({ map: map, toneMapped: false }));
      screen.position.z = 0.025;
      g.add(screen);
      // Glass: a faint sheen across the screen.
      var glass = new THREE.Mesh(screenGeometry(w - inset * 2, h - inset * 2, Math.max(0.02, r - inset)), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, roughness: 0.05, metalness: 0, clearcoat: 1 }));
      glass.position.z = 0.03;
      g.add(glass);
      return g;
    }

    // The iPhone plays the app's own film; the iPad shows the till's sale screen.
    var video = document.createElement('video');
    video.src = '/media/pay-iphone.mp4';
    video.muted = true; video.loop = true; video.playsInline = true; video.setAttribute('playsinline', '');
    video.crossOrigin = 'anonymous';
    var phoneMap = tex(new THREE.VideoTexture(video));
    if (!reduced) video.play().catch(function () {});
    var padMap = tex(loader.load('/img/shots/ipad-01-sale.webp'));

    var rig = new THREE.Group();
    scene.add(rig);
    var ipad = device(3.3, 2.47, 0.2, 0.08, padMap);
    ipad.position.set(0.55, 0.15, -0.6);
    ipad.rotation.set(-0.12, -0.42, 0.04);
    rig.add(ipad);
    var phone = device(1.08, 2.34, 0.17, 0.07, phoneMap);
    phone.position.set(-1.05, -0.35, 0.8);
    phone.rotation.set(0.05, 0.32, -0.05);
    rig.add(phone);

    // The card, and the rings that rise from the top of the iPhone.
    var card = new THREE.Mesh(
      new THREE.ExtrudeGeometry(roundedShape(1.0, 0.63, 0.07), { depth: 0.015, bevelEnabled: false, curveSegments: 10 }),
      new THREE.MeshStandardMaterial({ color: 0xa5c715, metalness: 0.35, roughness: 0.3, emissive: 0x2a3305 })
    );
    phone.add(card);
    var rings = [];
    for (var k = 0; k < 3; k++) {
      var ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.012, 8, 64, Math.PI * 0.6), new THREE.MeshBasicMaterial({ color: 0xa5c715, transparent: true, opacity: 0 }));
      ring.rotation.z = Math.PI * 0.2;
      ring.position.set(0, 0.95, 0.2);
      phone.add(ring);
      rings.push(ring);
    }

    // Lime dust.
    var n = 700, pts = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      pts[i * 3] = (Math.random() - 0.5) * 16;
      pts[i * 3 + 1] = (Math.random() - 0.5) * 10;
      pts[i * 3 + 2] = (Math.random() - 0.5) * 8 - 2;
    }
    var dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    var dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xa5c715, size: 0.03, transparent: true, opacity: 0.7, depthWrite: false }));
    scene.add(dust);

    // Layout: the pair to the right of the words on a wide screen, above them on a narrow one.
    var narrow = false;
    function resize() {
      var w = canvas.clientWidth, h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      narrow = w < 900;
      // On a phone the canvas is only the top of the hero (style.css): fit the pair to its width.
      var seen = 2 * camera.position.z * Math.tan(camera.fov * Math.PI / 360) * camera.aspect;
      rig.scale.setScalar(narrow ? Math.min(1, seen / 5.2) : 1);
      rig.userData.base = narrow ? new THREE.Vector3(0.1, 0, 0) : new THREE.Vector3(2.2, 0, 0);
    }
    window.addEventListener('resize', resize);
    resize();

    var pointer = { x: 0, y: 0 }, eased = { x: 0, y: 0 };
    window.addEventListener('pointermove', function (e) {
      pointer.x = e.clientX / window.innerWidth - 0.5;
      pointer.y = e.clientY / window.innerHeight - 0.5;
    }, { passive: true });

    var visible = true;
    if (io) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; }).observe(canvas);

    // Zoom mode (a page with html.zoom-hero, wide screens): the hero is a tall
    // scroll scene; the iPad drifts back and the iPhone comes to the middle,
    // grows and turns to face you (go.vesopa.com polish, 2026-11-06).
    var hero = document.getElementById('hero');
    var zoomCap = document.querySelector('.zoom-caption');
    card.material.transparent = true;
    function smooth(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }
    function lerp(a, b, k) { return a + (b - a) * k; }

    var clock = new THREE.Clock();
    function frame() {
      var t = clock.getElapsedTime();
      var scroll = Math.min(1, window.scrollY / Math.max(1, canvas.clientHeight));
      var zoom = root.classList.contains('zoom-hero') && !narrow;
      var z = 0;
      if (zoom) {
        z = smooth(window.scrollY / Math.max(1, hero.offsetHeight - window.innerHeight));
        scroll = 0;
        if (zoomCap) { var past = window.scrollY - (hero.offsetHeight - window.innerHeight); var kc = smooth((z - .62) / .25) * (1 - smooth(past / (window.innerHeight * .35))); zoomCap.style.opacity = kc.toFixed(3); zoomCap.style.transform = 'translate3d(-50%,' + ((1 - kc) * 24).toFixed(1) + 'px,0)'; }
      }
      eased.x += (pointer.x - eased.x) * 0.06;
      eased.y += (pointer.y - eased.y) * 0.06;

      var base = rig.userData.base;
      var calm = 1 - z * .8; // the pointer moves it less once it faces you
      rig.position.set(lerp(base.x, 0, z), base.y + Math.sin(t * 0.8) * 0.06 + scroll * 1.6, base.z - scroll * 2.5);
      rig.rotation.set((eased.y * 0.25) * calm + scroll * 0.5, (eased.x * 0.45 + Math.sin(t * 0.3) * 0.05) * calm, 0);
      ipad.position.set(0.55 + z * 2.4, 0.15 + Math.sin(t * 0.9 + 1) * 0.05 - z * 0.3, -0.6 - z * 3.2);
      ipad.rotation.set(-0.12 - z * 0.1, -0.42 - z * 0.25, 0.04);
      phone.position.set(lerp(-1.05, 0, z), lerp(-0.35, 0.05, z) + Math.sin(t * 1.1) * 0.07 * (1 - z * .6), lerp(0.8, 1.9, z));
      phone.rotation.set(lerp(0.05, 0, z), lerp(0.32, 0, z), lerp(-0.05, 0, z));
      phone.scale.setScalar(1 + z * 0.55);
      card.material.opacity = 1 - smooth(z / .25);
      card.visible = card.material.opacity > 0.01;

      // The card's loop, 3.2 s: in from above, held at the reader, away.
      var c = (t % 3.2) / 3.2;
      var inT = 1 - Math.pow(1 - Math.min(1, c / 0.4), 3);
      var outT = Math.max(0, Math.min(1, (c - 0.72) / 0.2));
      outT = outT * outT * (3 - 2 * outT);
      var away = (1 - inT) + outT;
      // Held flat over the top of the screen, where the reader is, as Apple shows it.
      card.position.set(-0.5 + away * 0.15, 0.62 + away * 1.0, 0.16 + away * 0.9);
      card.rotation.set(-0.12 - away * 0.7, away * 0.2, -0.04 - away * 0.3);
      var near = Math.max(0, 1 - away);
      rings.forEach(function (r, i) {
        var p = (t * 0.7 + i / 3) % 1;
        r.scale.setScalar(0.6 + p * 1.6);
        r.position.y = 0.95 + p * 0.25;
        r.material.opacity = Math.sin(p * Math.PI) * (0.35 + 0.65 * near) * (1 - smooth(z / .25));
      });
      rim.intensity = 1.6 + near * 1.6;

      dust.rotation.y = t * 0.02;
      dust.position.y = -scroll * 1.2;
      renderer.render(scene, camera);
    }
    function loop() {
      if (visible) frame();
      requestAnimationFrame(loop);
    }
    if (reduced) {
      padMap.image ? frame() : setTimeout(frame, 600);
      window.addEventListener('resize', frame);
    } else {
      loop();
    }
  }
})();
