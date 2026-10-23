# pontardawerfc.com

Pontardawe RFC's website. Node + Express, no build step: pages are rendered
on the server from `content/*.json`, styled by `public/css/site.css`, with two
small scripts (`public/js/site.js`, `public/js/order.js`).

    npm install
    npm run dev         # http://127.0.0.1:5090
    npm test            # every page, the SEO files, redirects, the helper

## Where things come from

| What | Where |
|---|---|
| Club facts, history, teams, FAQ | `content/club.json` (from the old site pontardawe.rfc.wales, Wikipedia, Companies House 10056776, the club's Facebook) |
| News | written at **pontardawerfc.com/admin** and kept in `data/` on the box (see *The news admin* below); `content/news.json` and `updates.json` are the posts it started with |
| Photos | `content/images/original/` (the old site's media); `tool/make_images.py` makes the web sizes, icons and share cards in `public/img/` |
| Old site's raw data | `content/source/` (WordPress pages, posts and media lists, kept for reference) |
| Menu, prices, allergens, opening hours | live from the club's Vesopa EPOS back office: `MENU_API`/api/public/dinein/venue/`MENU_SLUG` |
| Orders | to a table: `POST /api/public/dinein/table/:code/order`; for collection: `POST /api/public/dinein/venue/:slug/order` (back office, turned on with **Orders for collection** in the Dine-in settings). Both land on the till. |
| Members' app | https://member.pontardawerfc.com/ (the Vesopa Loyalty web app, served by the back office for the venue `pontardawe-rfc`) |
| AI helper | `src/helper.js`: `POST /api/ask`, grounded only on `content/`, through the shared Vesopa AI client (`src/vesopa_ai.js`, synced from `shared/ai-client` by `tool/sync-ai-client.sh`). With no key it answers from the FAQ. |

## Settings (.env on the box, never in git)

    PORT=5090
    SITE_URL=https://pontardawerfc.com
    MEMBERS_URL=https://member.pontardawerfc.com
    MENU_API=https://menu.vesopa.com
    MENU_SLUG=pontardawe-rfc
    DEEPSEEK_API_KEY=…      GEMINI_API_KEY=…   (optional: the helper)
    AI_DAILY_CAP_USD=0.5
    LOG_DIR=…/logs
    DATA_DIR=…/data          (the news admin's posts, photos and logins)
    SESSION_SECRET=…         ADMIN_SETUP_CODE=…   (both written by remote-install.sh)

## Deploy

From the repository root on the owner's PC:

    python tool/deploy_pontardawe_site.py --check
    python tool/deploy_pontardawe_site.py

`scripts/remote-install.sh` does the box side and is safe to run again.

## Fixtures, tickets, X posts and the club email (2026-10-11)

- `/fixtures`: fixtures, results and the league table, read every 20 minutes from the WRU's public API (`src/wru.js`, organisation 165). The next match also shows on the home page with a countdown. `WRU_OFF=1` stops the reads (the tests set it).
- `/tickets`: home matches. Online tickets appear when the club has a "Tickets" section on its online menu (a TICKETS screen on the till; `tool/pontardawe_menu.py`), bought through the normal order and collected at the gate.
- `/news` lists every post saved from x.com/PontardaweRFC (`content/source/x-posts.json`).
- `info@pontardawerfc.com` is a mailbox on the box (IMAP/SMTP at mail.pontardawerfc.com) that also forwards a copy to `club.json` `email_forwards_to` (info@vesopasoftware.com); `contact@` only forwards. Both through `scripts/mail-forward.sh`, run by `tool/deploy_pontardawe_site.py` and `tool/pontardawe_mail_fix.py` (which also saves the SMTP settings in the site's .env). pontardawerfc.com is a verified sender domain in SMTP2GO (2026-10-12).

## The news admin (2026-10-23)

The club writes its own news at **https://pontardawerfc.com/admin**: title, story
(bold, headings, lists, quotes, links, photos in the text), photos with a cover,
a category, an optional event date and button, the web address and the title in
Google. Save as a draft, publish now, or pick a date and time still to come to
schedule it. A published post is at once on the home page's latest news, `/news`
(12 a page), its own page, What's On (if it has a category other than "News only"),
`/news/feed.xml` and `sitemap.xml`. Renaming a post's address keeps the old one
working (301).

| | |
|---|---|
| `src/posts.js` | the store, `data/posts.json`: every post and the uploaded photos' sizes and alt text. The shipped posts in `content/` are copied in on first start (and any new one later, unless it was deleted in the admin). The story is cleaned to plain tags on save (`sanitize-html`) |
| `src/uploads.js` | a photo becomes `data/uploads/<id>.jpg`, `.webp`, `-480.webp` and `-og.jpg` (1200x630, for shared links), turned upright, its location data dropped (`sharp`); served at `/img/u/` |
| `src/admin.js`, `admin_views.js`, `admin_auth.js` | the pages, and the logins in `data/users.json` (scrypt hashes, a signed cookie, a token on every form, 8 tries per email and 40 per address in 15 minutes) |
| `public/js/admin.js`, `public/css/admin.css` | the editor's text tools and uploads (photos shrunk to 2400px in the browser first) |

`data/` is outside what a deploy replaces. `scripts/remote-install.sh` makes it,
writes `SESSION_SECRET` and `ADMIN_SETUP_CODE`, prints the setup code while
nobody can sign in yet, and installs a nightly copy of `data/` to `backups/`
(30 kept, `/etc/cron.d/pontardawerfc-news-backup`).

Photos no post uses any more (taken off a post, from a deleted post, or added
to a post that was never saved) are deleted a day after they were uploaded,
checked every six hours (`posts.sweepPhotos`).

First login: open `/admin/setup`, enter the setup code, your name, email and a
password. More people: **Editors** (owners only). A forgotten password: an owner
sets a new one under Editors.

Locally: `npm run dev` with `ADMIN_SETUP_CODE=anything` in `.env`; posts go to
`website/data/` (gitignored). The tests use a temporary data folder.
