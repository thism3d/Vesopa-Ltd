---
name: pontardawe-website
description: Work on pontardawerfc.com (PontardaweRFC/website) — news posts and their pictures, the home page, the news admin, automatic match news, and shipping it live. Use when a task mentions pontardawerfc.com, Pontardawe news/homepage/images, the club website, or /admin on that site.
---

# pontardawerfc.com

Node + Express, no build step, in `PontardaweRFC/website/`. Read its `README.md`
first: it maps every file. Pontardawe RFC is a live customer, so change only
what you were asked to.

## Where the news really is

The news is **not in git**. The club writes posts at https://pontardawerfc.com/admin
and they live in `data/posts.json` plus `data/uploads/` on the Cloud box, which a
deploy never touches. `content/news.json` and `updates.json` are only the posts
the site started with. So:

- To see what's on the live site, fetch it: `curl -s https://pontardawerfc.com/news`.
  Don't go by local `website/data/`.
- To fix one post's words or photo: the club (or you, signed in at /admin) edits
  it there. To fix how every post looks: change the code and deploy.

## Pictures on news cards (2026-10-25)

`posts.view()` gives each post a `cover`: its own photo, or else the first
uploaded photo in its story. A post with neither gets a club-red card drawn by
`src/news_card.js`, using `src/match_card.js` (crest, Oswald, title, date). The
card is drawn once in the background, saved to `data/cards/`, served at
`/img/c/<key>`, and never saved on the post. Cards, the What's On posters and
link previews use `cover`; the top of an article still uses only `post.image`.
Photos uploaded in the admin come in four sizes (`src/uploads.js`, under `/img/u/`).

Only the club's own crest is ever drawn. No other club's badge, and no AI
pictures of the crest: they get its design wrong.

## Test and ship

```powershell
cd PontardaweRFC\website; npm test          # three autonews tests fail on today's date (known, not yours)
cd ..\..; python tool/deploy_pontardawe_site.py --check
python tool/deploy_pontardawe_site.py --site-only     # site, mail check, APK downloads; restarts pm2 "pontardawerfc.com"
```

Run the deploy from PowerShell: from Git Bash the upload has stopped partway.
Afterwards, fetch the live pages and check every card's picture answers with a 200.

Working-tree `src/*.js` files are CRLF; `test/admin.test.js` is LF. Use the Edit
tool. Bash heredocs drop `\\` in JavaScript regexes.
