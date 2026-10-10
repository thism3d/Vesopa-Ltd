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
| News | `content/news.json` (the old site's posts, plus the launch post) |
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

## Deploy

From the repository root on the owner's PC:

    python tool/deploy_pontardawe_site.py --check
    python tool/deploy_pontardawe_site.py

`scripts/remote-install.sh` does the box side and is safe to run again.
