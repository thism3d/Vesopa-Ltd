# Bangla on cloud.vesopa.com

2026-09-17. The site is published in English and Bangla: 1,065 strings across
the public pages, the signed-in panel, the sign-in screens and the browser
scripts. This is the record of what was done and how — the durable half of it
lives in `vesopa_hosting/README.md` under *Two languages*.

---

## What was already there

The engine. `vesopa_hosting/src/i18n/index.js` was written before this pass and
was complete: the `LOCALES` table, the `/bn` prefix middleware, the `vh_lang`
cookie, the catalogue loader, `hreflang` alternates, the link rewriting that
keeps a Bangla page's links Bangla, and the AsyncLocalStorage that lets code
with no `req` to hand still know the language. `public/assets/js/i18n.js` was
the browser half. `head.ejs`, `server.js` and `currency.js` were wired to it.
Noto Sans Bengali had been downloaded.

## What was missing

Everything the engine was built to carry:

* `src/i18n/bn/` was **empty** — `/i18n/bn.js` served `{"messages":{}}`.
* `/assets/css/bn.css` **404'd on every Bangla page**; `head.ejs` asked for it.
* **One of 96 templates** was wrapped in `t()`. The other 95 were not.
* **82 route titles** and every flash message were bare English literals.
* There was **no language switcher** anywhere in the UI.
* `npm run i18n:check` — which `index.js` says is what "complete" means — **did
  not exist**.

So `/bn/hosting` answered 200 with `<html lang="bn">` and correct `hreflang`,
and served an entirely English page in a font the browser had to guess at.

---

## How it was done

### 1. The tooling first, because the check defines "done"

`scripts/i18n-extract.js` reads every `t()`, `th()`, `tn()`, `req.t()` and
`VT.t()` in the source and merges the keys it finds into the catalogue without
touching a translation already written. `scripts/i18n-check.js` runs it, then
fails the build on a missing translation, a mismatched `{placeholder}`, a
mismatched `<tag>`, one English string with two different translations, or a
browser string that is not in `client.json`.

Two things the extractor has to do that a regular expression cannot:

* **Skip comments.** `src/i18n/index.js` and `public/assets/js/i18n.js` both
  document themselves with `VT.t('Copied')`, and a scanner that reads comments
  puts its own examples in the catalogue. `'https://x'` is a string containing
  what looks like a comment and `// a string's apostrophe` is a comment
  containing what looks like a string, so it walks the text in one of four
  states instead of matching.
* **Refuse a bare `translate(`.** It is also CSS. The panel's scripts build
  `transform: translate(8px, 0)`, and a bare match put a chunk of arithmetic in
  the catalogue on the first run.

### 2. A codemod for the templates, not 96 files by hand

`t()`-wrapping 13,000 lines of EJS by hand is a week and a hundred typos.
A codemod did it in a form that could be reviewed as a list before it wrote
anything — but only after four faults were found and fixed, each of which had
already produced broken output:

| Fault | What it produced |
| --- | --- |
| A tag was assumed to end at the next `>` | `<header class="nav <%= over ? … %>" data-nav>` ends at the `>` inside `%>`, so `" data-nav>` was wrapped as if it were a sentence |
| An HTML comment was parsed as a tag | `<!-- What's included -->` — the apostrophe opened an attribute quote that never closed, swallowing the `<pre>` of sample code that followed, whose contents were then wrapped |
| `peel()` counted opens against closes | `<span>Backups</span><span class="strong">Daily</span>` has one of each inside, so a count said "balanced" and peeled an opening tag whose close is in the middle — the key began `Backups</span>` |
| `<code>` was treated as raw | Every `<code>` here is a short identifier inside a sentence — `.env`, `PORT` — so sentences were cut in half and offered as `<b>Leave` and `alone.</b>` |

The rule that makes the output worth translating: **a sentence is the unit, not
a text node.** Inline elements are gathered into the sentence and the key keeps
its markup, printed with `th()`:

```
<%- th('Paid certificates do still exist for two real cases: <b>organisation
and extended validation</b>, where a certificate authority verifies …') %>
```

Written as three text nodes, a translator gets a fragment and a fragment
beginning with a comma — and Bengali does not put its clauses in English order,
so a translation assembled from fragments is word salad however good each
fragment is. A phrase that is one element wrapping all of its text —
`<a href="/x">Help</a>` — is peeled instead, so the key is `Help` and a changed
URL cannot invalidate a translation. Two links in one phrase, a `btn`, or a
sentence with `<%= %>` in the middle of it are reported for a person rather
than guessed at; 325 were, and were done by hand.

### 3. A name collision that only showed at runtime

`<% tlds.forEach(function (t) { %>` was fine until `t` also meant "translate".
Inside that loop `t('Search')` calls a TLD row as a function, and `/domains`
500'd. The two uses are distinguishable without knowing any types — a row is
never *called* — so `scripts`-adjacent `unshadow.js` renamed the loop variable
in the eight templates that shadowed it, leaving `t(` alone. Loop variables are
now `tld`, `term`, `type`, `ticket`, `row`.

### 4. The translation

1,065 strings, in batches, merged by a tool that **refuses a key the catalogue
does not already have** — because the catalogue's keys come from the source, so
a key that is not there means the English was mistyped, and a mistyped key is a
string that silently stays English for ever.

Terminology is **loanwords in Bengali script** — হোস্টিং, ডোমেইন, ইমেইল,
সার্ভার — the owner's choice, because that is how Bangladeshi hosting customers
write them. Formal আপনি throughout. Prices, dates and counts are Bangla
numerals, grouped the Bangla way, except inside `.mono`.

### 5. Search engines

`sitemap.xml` now lists every page once per language, each entry naming the
others and an `x-default`. Google ignores a one-sided `hreflang` pair and judges
the two as duplicate sites, so the head and the sitemap both carry it.
`robots.txt` disallows `/lang/` and `/currency/`. Meta titles and descriptions
are translated, including the ones quoting a live price — by interpolation,
`{price}`, never concatenation.

`/build` was added to the sitemap while there. It is a public marketing page
that had never been listed.

---

## What was decided, not defaulted

**The legal documents stay English.** Terms, privacy, AUP and refunds are
published in English in every language, with a translated notice saying the
English text is the one that applies. A contract translated into a second
language is a second contract. The owner chose this over a marked
"non-binding" translation.

**The transactional emails stay English for now.** Sending one in the
customer's language needs a `customers.locale` column; the owner chose not to
take the schema change this pass. `withLocale()` is written and waiting.

**Admin is not translated.** Staff-only, never indexed, read by the two people
who run the platform.

**`assistant.js` and `build.js` were not touched.** Both already carry their own
Bangla tables from the Vesopa AI and Studio work, and those are better than a
scanner's output — they have the voice lines in them.

---

## Verified, not assumed

On the panel running locally against a local MariaDB, signed in as the seed
customer:

* **30 pages, 200 in both languages** — every public page, and the whole
  signed-in panel with `vh_lang=bn`.
* **Zero `[i18n] no bn for:` warnings** in the log after walking them. That
  line fires on any key the catalogue misses, so zero is the measurement.
* **Zero `[error]` lines.**
* `npm run i18n:check` **exits 0**: 1,065 strings, five catalogue files, no
  placeholder, markup, duplicate or not-served faults. It also reports 33
  strings left in English on purpose — `SMTP`, `IMAP`, `Ctrl`, `PDF`, brand
  names, example domains — so that "untranslated" and "deliberately English"
  are different things rather than the same silence.

To see a signed-in panel on localhost, the launcher sets
`VESOPA_AUTH_PANEL_ONLY=off`: Continue-with-Vesopa hands off to
auth.vesopa.com, which has no redirect registered for `localhost`, and the
panel is half the pages being translated.
