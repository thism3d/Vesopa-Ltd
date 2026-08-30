/**
 * What a customer can install in one click, and what each one needs.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS HALF OF A CONTRACT. The other half is apps/broker.py.
 * ---------------------------------------------------------------------------
 * Here: the NAMES. What an app is called, what it is for, which logo goes on
 * the card, whether it wants a database, which runtime it runs on. All of it
 * presentation and validation, none of it executable.
 *
 * There: the RECIPES. The actual sequence of commands that puts each app on
 * disk, keyed by the same slug.
 *
 * The web tier never sends a command. It sends a slug and a handful of
 * validated parameters, and the broker looks the slug up in its own table. If
 * it does not recognise the slug, nothing happens. That is deliberate: an
 * installer that accepted "here is the shell to run" from the web tier would
 * turn every hole in a route into a hole on the box, and this is the one
 * feature where the temptation to do that is strongest.
 *
 * SO THE TWO SLUG LISTS MUST STAY IN STEP. Add an app here and the button
 * appears and then fails; add it there only and nobody can reach it. There is
 * a test for exactly this — `npm run check:apps` — because the failure mode is
 * a customer-visible 500 rather than anything that shows up at boot.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CATALOGUE AND NOT A LONGER ONE
 * ---------------------------------------------------------------------------
 * Softaculous ships four hundred applications and the honest number that
 * anybody installs is about twelve. A long list is not generosity; it is a
 * maintenance promise — every entry is a thing that breaks on its own schedule
 * when upstream changes a tarball URL or a minimum PHP version, and a broken
 * one-click install is worse than no button at all, because it leaves half an
 * application in the customer's web root.
 *
 * So: the ones people actually ask for, each one verified to install on this
 * node, and room to grow.
 */

/*
 * Document root, and why some apps need a different one.
 *
 * Hestia serves `~/web/<domain>/public_html`. Most PHP applications are happy
 * with that — you unpack the tarball into it and the index.php is right there.
 * Modern frameworks are not: Laravel, Symfony and Drupal-via-composer keep the
 * application ABOVE the web root on purpose, so that a misconfigured server
 * cannot serve `.env` or the vendor tree as plain text. Their public directory
 * is a small shim that boots the app from outside it.
 *
 * Installing those into public_html anyway is the single most common way a
 * shared host leaks database credentials, so this does not do it. Where an app
 * declares `docroot`, the installer asks Hestia to move the domain's root to
 * that subdirectory. If the node refuses, the install stops before any file is
 * written rather than falling back to the unsafe layout.
 */

const APPS = [
  // ---- PHP -------------------------------------------------------------
  {
    slug: 'wordpress',
    name: 'WordPress',
    kind: 'php',
    tagline: 'Blogs, brochure sites, shops',
    blurb:
      'The one most sites run on. Comes with a theme, an admin area and thirty '
      + 'thousand plugins. If you are not sure what you want, this is the safe answer.',
    logo: 'wordpress.svg',
    site: 'https://wordpress.org',
    licence: 'GPLv2',
    needs: { database: 'mysql', php: '8.2' },
    docroot: null,
    minutes: 1,
    popular: true,
  },
  {
    slug: 'laravel',
    name: 'Laravel',
    kind: 'php',
    tagline: 'A PHP framework to build on',
    blurb:
      'An empty, properly-wired PHP application — router, database layer, queue, '
      + 'the lot. For building something, not for filling in a form.',
    logo: 'laravel.svg',
    site: 'https://laravel.com',
    licence: 'MIT',
    needs: { database: 'mysql', php: '8.2', composer: true },
    docroot: 'public',
    minutes: 3,
  },
  {
    slug: 'drupal',
    name: 'Drupal',
    kind: 'php',
    tagline: 'Structured content, done properly',
    blurb:
      'Heavier than WordPress and far better at complicated content — many types, '
      + 'many languages, real editorial workflow. Universities and governments run it.',
    logo: 'drupal.svg',
    site: 'https://www.drupal.org',
    licence: 'GPLv2',
    needs: { database: 'mysql', php: '8.3' },
    docroot: null,
    minutes: 2,
  },
  {
    slug: 'joomla',
    name: 'Joomla',
    kind: 'php',
    tagline: 'A CMS with more built in',
    blurb:
      'Sits between WordPress and Drupal. Multilingual and access control come in '
      + 'the box rather than as plugins.',
    logo: 'joomla.svg',
    site: 'https://www.joomla.org',
    licence: 'GPLv2',
    needs: { database: 'mysql', php: '8.2' },
    docroot: null,
    minutes: 2,
  },
  {
    slug: 'prestashop',
    name: 'PrestaShop',
    kind: 'php',
    tagline: 'A shop, without WordPress',
    blurb:
      'A shop first and a website second — stock, VAT, carriers and invoices are '
      + 'core features here rather than an add-on.',
    logo: 'prestashop.svg',
    site: 'https://prestashop.com',
    licence: 'OSL-3.0',
    needs: { database: 'mysql', php: '8.1' },
    docroot: null,
    minutes: 4,
  },
  {
    slug: 'moodle',
    name: 'Moodle',
    kind: 'php',
    tagline: 'Courses and coursework',
    blurb:
      'The learning platform most colleges use. Courses, enrolment, assignments, '
      + 'marking. Big, and worth it if that is the job.',
    logo: 'moodle.svg',
    site: 'https://moodle.org',
    licence: 'GPLv3',
    needs: { database: 'mysql', php: '8.2' },
    docroot: null,
    minutes: 5,
  },
  {
    slug: 'nextcloud',
    name: 'Nextcloud',
    kind: 'php',
    tagline: 'Your own Dropbox',
    blurb:
      'Files, calendar and contacts on your own hosting, with desktop and phone '
      + 'apps that sync to it.',
    logo: 'nextcloud.svg',
    site: 'https://nextcloud.com',
    licence: 'AGPLv3',
    needs: { database: 'mysql', php: '8.2' },
    docroot: null,
    minutes: 4,
  },

  // ---- Node ------------------------------------------------------------
  {
    slug: 'node-starter',
    name: 'Node.js app',
    kind: 'node',
    tagline: 'An empty Express server, running',
    blurb:
      'A working Node application with nothing in it — a server, a package.json '
      + 'and a health check. Deploy your own code over the top with git or the '
      + 'file manager.',
    logo: 'nodedotjs.svg',
    site: 'https://nodejs.org',
    licence: 'MIT',
    needs: { node: 'default' },
    minutes: 1,
    popular: true,
  },
  {
    slug: 'nextjs',
    name: 'Next.js',
    kind: 'node',
    tagline: 'React, server-rendered',
    blurb:
      'The React framework. Builds to a real server process here rather than a '
      + 'static export, so API routes and server components work.',
    logo: 'nextdotjs.svg',
    site: 'https://nextjs.org',
    licence: 'MIT',
    needs: { node: 20, build: true },
    minutes: 5,
  },
  {
    slug: 'ghost',
    name: 'Ghost',
    kind: 'node',
    tagline: 'Publishing and newsletters',
    blurb:
      'A writing platform with paid memberships and email newsletters built in. '
      + 'Much less to configure than WordPress if all you want is to publish.',
    logo: 'ghost.svg',
    site: 'https://ghost.org',
    licence: 'MIT',
    needs: { database: 'mysql', node: 22 },
    minutes: 5,
  },
  {
    slug: 'strapi',
    name: 'Strapi',
    kind: 'node',
    tagline: 'A headless CMS',
    blurb:
      'Content out of an API, with an admin area to edit it. For when the front '
      + 'end is an app or a static site and only the content needs a home.',
    logo: 'strapi.svg',
    site: 'https://strapi.io',
    licence: 'MIT',
    needs: { database: 'mysql', node: 22, build: true },
    minutes: 6,
  },
  {
    slug: 'n8n',
    name: 'n8n',
    kind: 'node',
    tagline: 'Automations between your tools',
    blurb:
      'Wire services together on a canvas — when this happens, do that. Self-hosted, '
      + 'so the data stays here.',
    logo: 'n8n.svg',
    site: 'https://n8n.io',
    licence: 'Sustainable Use Licence',
    needs: { node: 22 },
    minutes: 5,
  },
  {
    slug: 'umami',
    name: 'Umami',
    kind: 'node',
    tagline: 'Analytics without the cookies',
    blurb:
      'Visitor numbers for your sites, on your own server. No cookie banner, '
      + 'because it does not set one.',
    logo: 'umami.svg',
    site: 'https://umami.is',
    licence: 'MIT',
    needs: { database: 'mysql', node: 22, build: true },
    minutes: 5,
  },
  {
    slug: 'uptime-kuma',
    name: 'Uptime Kuma',
    kind: 'node',
    tagline: 'Watches your sites and shouts',
    blurb:
      'Pings the things you care about and tells you the moment one stops '
      + 'answering. Status pages included.',
    logo: 'uptimekuma.svg',
    site: 'https://uptime.kuma.pet',
    licence: 'MIT',
    needs: { node: 22 },
    minutes: 4,
  },

  // ---- Nothing at all ---------------------------------------------------
  {
    slug: 'static',
    name: 'Static site',
    kind: 'static',
    tagline: 'An index.html and nothing else',
    blurb:
      'A holding page you can replace. Right answer for anything built by Hugo, '
      + 'Astro, Eleventy or by hand — upload the output and it is live.',
    logo: null,
    icon: 'code',
    site: null,
    licence: null,
    needs: {},
    minutes: 1,
  },
];

const BY_SLUG = new Map(APPS.map((app) => [app.slug, app]));

/** Every app, or only the ones for one runtime. */
function list({ kind } = {}) {
  return kind ? APPS.filter((a) => a.kind === kind) : APPS.slice();
}

function find(slug) {
  return BY_SLUG.get(String(slug || '')) || null;
}

/**
 * The groups the catalogue page draws, in the order it draws them.
 *
 * Node comes first, and that is not alphabetical or arbitrary. Every other
 * panel on the market treats Node as an afterthought behind a wall of PHP
 * CMSes; the customers asking for this one are asking for Node.
 */
const GROUPS = [
  {
    kind: 'node',
    title: 'Node.js',
    note: 'Runs as a real process with pm2 keeping it alive. You pick the Node version.',
  },
  {
    kind: 'php',
    title: 'PHP',
    note: 'Served by PHP-FPM. You pick the PHP version per site, and can change it later.',
  },
  {
    kind: 'static',
    title: 'Plain HTML',
    note: 'No runtime at all — files served straight off disk, which is as fast as it gets.',
  },
];

module.exports = {
  APPS, GROUPS, list, find,
};
