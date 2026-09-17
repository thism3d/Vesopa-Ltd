/**
 * Vesopa Studio's pages: build a website by talking, and watch it happen.
 *
 *   GET /build            the studio (public: anybody may build; publishing
 *                         needs a Vesopa account with hosting)
 *   GET /build/frame      the preview's document -- an empty page with its OWN
 *                         Content-Security-Policy, which the studio fills in
 *   GET /build/site.css   the design system every Studio site is made of
 *
 * WHY THE PREVIEW HAS ITS OWN PAGE. The panel's CSP (server.js) allows images
 * and fonts from this origin only, and a srcdoc frame inherits it, so a
 * preview there could show neither Google Fonts nor a photo address the
 * customer gives. This page allows those, allows no script whatsoever (CSP
 * and sandbox both), and is same-origin so the studio can write the site into
 * it. Whatever the model writes can be drawn there; nothing it writes can run.
 *
 * The turn, hearing, domains and publish calls are under /ai/build (routes/ai.js),
 * behind the same CSRF, origin, token and rate limits as the rest of Vesopa AI.
 */

const crypto = require('crypto');
const express = require('express');
const kit = require('../builder/kit');

const router = express.Router();
const cssVersion = () => crypto.createHash('sha1').update(kit.siteCss()).digest('hex').slice(0, 10);

router.get('/', (req, res) => {
  res.render('public/build', {
    title: 'Studio — build your website by talking',
    description: 'Say what your business does and watch your website appear. Change anything by saying so, then publish it to your own domain.',
    aiEnabled: false, // the studio has its own voice; the floating guide would talk over it
    nativeNav: true,
    sections: false,
    extraCss: '/assets/css/build.css',
    bodyClass: 'studio-body',
    signedIn: Boolean(req.customer),
  });
});

router.get('/frame', (req, res) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    'img-src https: data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    'sandbox allow-same-origin',
  ].join('; '));
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html lang="en-GB" class="vs-editor">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/build/site.css?v=${cssVersion()}">
<link rel="stylesheet" id="vs-fonts">
<style id="vs-theme"></style>
<style>
  /* Editing aids, never published. */
  html.vs-editor *, html.vs-editor *::before, html.vs-editor *::after { animation: none !important; }
  body, .v-nav, .v-section, .v-hero, .v-card, .v-btn, .v-art, .v-ph, .v-cta, .v-footer { transition: background-color .6s ease, color .6s ease, border-color .6s ease; }
  [data-sec] > * { position: relative; }
  .vs-hover { outline: 2px dashed rgba(165, 199, 21, .95) !important; outline-offset: -3px; cursor: pointer; }
  .vs-selected { outline: 3px solid #a5c715 !important; outline-offset: -3px; }
  .vs-writing { outline: 2px solid rgba(165, 199, 21, .9) !important; outline-offset: -3px; box-shadow: inset 0 0 0 100vmax rgba(165, 199, 21, .035) !important; }
  .vs-born { animation: vs-born .7s cubic-bezier(.2,.8,.2,1) both !important; }
  @keyframes vs-born { from { opacity: .35; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  body:empty { min-height: 100vh; }
</style>
</head>
<body></body>
</html>`);
});

router.get('/site.css', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('css').send(kit.siteCss());
});

module.exports = router;
