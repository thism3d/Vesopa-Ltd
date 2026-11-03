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
    if (rail && !reduced) {
      var rr = rail.parentElement.getBoundingClientRect();
      var q = (vh - rr.top) / (vh + rr.height); // 0 entering .. 1 leaving
      var travel = Math.max(0, rail.scrollWidth - window.innerWidth);
      rail.style.transform = 'translate3d(' + (-q * travel).toFixed(1) + 'px,0,0)';
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

  // Films play only on screen (and not at all with reduced motion).
  document.querySelectorAll('video').forEach(function (v) {
    if (reduced) { v.removeAttribute('autoplay'); v.pause(); return; }
    if (!io) return;
    new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { v.play().catch(function () {}); } else { v.pause(); } });
    }).observe(v);
  });

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

    var clock = new THREE.Clock();
    function frame() {
      var t = clock.getElapsedTime();
      var scroll = Math.min(1, window.scrollY / Math.max(1, canvas.clientHeight));
      eased.x += (pointer.x - eased.x) * 0.06;
      eased.y += (pointer.y - eased.y) * 0.06;

      var base = rig.userData.base;
      rig.position.set(base.x, base.y + Math.sin(t * 0.8) * 0.06 + scroll * 1.6, base.z - scroll * 2.5);
      rig.rotation.set(eased.y * 0.25 + scroll * 0.5, eased.x * 0.45 + Math.sin(t * 0.3) * 0.05, 0);
      ipad.position.y = 0.15 + Math.sin(t * 0.9 + 1) * 0.05;
      phone.position.y = -0.35 + Math.sin(t * 1.1) * 0.07;

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
        r.material.opacity = Math.sin(p * Math.PI) * (0.35 + 0.65 * near);
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
