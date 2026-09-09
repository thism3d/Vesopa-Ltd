# Vesopa OAuth — design reference

What the twenty-one reference screenshots in this folder actually show, what
each one is being kept for, and what it means for `auth.vesopa.com`. Written
from the images themselves, not from memory of how Google Account looks.

The reference is **Google Account on a phone** (`myaccount.google.com` and
`accounts.google.com`, dark mode, 1080×2340). That is the right comparison:
Google Account is the only widely-used consumer product that does exactly what
Vesopa OAuth has to do — one identity, several products hanging off it,
security settings a non-technical person has to be able to work through alone,
and a subscriptions list.

The faults being fixed are in `../design_mistakes/`, catalogued at the end.

---

## 1. The shape of every screen

Every reference screen is the same three bands:

| Band | Contents | Notes |
|---|---|---|
| **Product bar** | "Google Account" wordmark, then search / help / apps / avatar | Fixed. The wordmark is *text-sized* — the cap height matches the icons beside it. |
| **Page title** | `←` back arrow, then the page name at ~32px | The back arrow is part of the title line, not the bar above it. |
| **Body** | Stacked cards and rows | Nothing else. No tab strip, no sidebar. |

**The single most important observation:** on a phone there is **no navigation
rail and no tab strip anywhere in the reference.** Navigation is a *hub page*
of rows; you tap a row, you get a page, you come back with the arrow. Vesopa
currently puts a horizontally-scrolling tab strip at the top of every account
page (`.rail` at `max-width: 900px`), and that strip is why "How you sign in" is
sliced in half in `photo_…735`.

---

## 2. The row — the atom of the whole design

Nearly everything in the reference is one component repeated:

```
┌──────────────────────────────────────────────┐
│  (icon)   Label                              │
│           Current value or description       │
└──────────────────────────────────────────────┘
```

- Icon left, ~24px, in a muted or tinted circle.
- Label at ~19px, normal weight, full contrast.
- Value/description under it at ~16px, muted.
- The whole row is the tap target, ~72–96px tall.
- Rounded ~14px. Rows in a group are separated by ~4px of background, so they
  read as one block without needing dividers.
- Groups are separated by a much larger gap (~32px). **Grouping is done with
  space, not with headings or boxes** — see `photo_…729`.

Variants seen:

| Variant | Where | Detail |
|---|---|---|
| Value row | `…720` Personal info | Label + value. The commonest. |
| Multi-value row | `…720` Email, Phone | Two values stacked under one label. |
| Thumbnail row | `…720` Profile picture | Avatar on the **right** edge. |
| Status-pill row | `…727` 2-Step Verification | Green "✓ On since Jun 1, 2025" / grey "⊖ Off" pill *under* the label. |
| Count row | `…724` Manage all devices | Number in a circular chip on the right. |
| Chevron row | `…721` Delete all | `›` on the right when it leads somewhere destructive. |
| Coloured-icon row | `…729`, `…730` hub | Icon in a **saturated** circle — green, blue, purple, orange, pink. Colour identifies the section. |

**Vesopa has this component already** — `.rail-item` has the tinted circular
icon and the tint classes (`t-brand`, `t-blue`, `t-violet`, `t-teal`, `t-amber`,
`t-pink`) are already defined in `console.css`. The work is to stop using it as
a *navigation rail* and start using it as the *page body*.

---

## 3. Screen-by-screen

### `photo_…730` — Account home (the hub) ★ the most important one

Top to bottom:

1. **Identity card** — large circular avatar with a **pencil badge on its
   bottom-right corner**, name at ~28px, email muted beneath, then a plan pill
   ("Plus") with a coloured glow.
2. **Family row** — icon left, label, and a *stack of overlapping avatars* on
   the right.
3. Then the section rows in colour-grouped clusters.

The pencil badge is the answer to the profile-picture complaint: **the picture
itself is the control.**

### `photo_…729` — the hub continued

Shows the grouping rhythm clearly. Purple cluster (AI plan, Wallet &
subscriptions), gap, green (Personal info), gap, blue cluster (Security,
Password, Linked apps), gap, orange (Data & privacy), gap, pink (People &
sharing). Subtitles are comma-lists of what is inside: *"Name, email, phone,
address"*, *"Payment Methods, Transactions"*.

### `photo_…720`, `…719` — Personal info

The whole page is rows. **There is not a single input on it.** Profile picture,
Name, Gender, Email, Phone, Birthday, Language, Home address, Work address,
Other addresses, Password. Tapping one opens an editor page.

This is the direct answer to *"The sections are not any good and I'm not liking
the UI anyhow."* Vesopa's `/account/profile` is one long form with Display name,
First name, Last name and Date of birth inputs all on screen at once. The
reference shows values and only presents an input once you have chosen what to
change.

### `photo_…715` — Password (the editor pattern)

What a row opens into:

- Explanatory paragraph with inline "Learn more ⓘ" links.
- A **floating-label** field: label sits on the top border in the accent colour
  while focused, border in accent colour, ~2px, generous ~72px height.
- Help text below in muted grey.
- A second, unfocused field for comparison — plain border, label *inside* as
  placeholder until focused.
- The action button **bottom-right**, pill-shaped, filled in a pale accent with
  dark text.
- Footer links.

### `photo_…716`, `…717`, `…718` — Sign-in (verifying)

- **The Google "G" is small — roughly 48×48, top-left.** Not a full-width
  wordmark. This is the direct measurement behind *"Logo is too big in my
  device"*: Vesopa's back-office sign-in renders the wordmark at ~830px on a
  1080px screen.
- "Hi Muzahid" at ~40px.
- An **account chip**: pill outline containing a small avatar, the email, and a
  `▾`. Tapping it switches account.
- Step title, then muted subtitle.
- A single blue text link, "Try another way", low on the page.
- **No card, no border, no panel.** The sign-in step sits directly on the
  background.

`…717` catches the **loading bar**: a thin (~3px) indeterminate bar pinned to
the very top of the viewport, lavender/blue, partially across. It is present
during page load, not only during in-page navigation.

### `photo_…727`, `…726`, `…725`, `…728`, `…723` — Security & sign-in

`…728` opens with a **status banner**: green shield, "Your account is
protected", explanation. Then "Recent security activity" as rows with dates,
ending in a count row.

`…727` — "How you sign in to Google": a section heading in plain text (not a
card) with a muted line under it, then rows: 2-Step Verification (green pill),
Passkeys, Password, Skip password when possible (grey "⊖ Off" pill),
Authenticator, Google prompt, 2-Step phones, Recovery phone.

`…726` — after the rows: *"You can add more sign-in options"* with **outlined
chip buttons** (icon + label, pill, ~48px) that wrap onto multiple lines.

`…725`, `…724` — "Your devices / Where you're signed in" — a section heading
plus muted line, device rows with a device-shaped icon, then "Find a lost
device" and "Manage all devices  ⑬".

`…723` — a **toggle row** rendered as a card: title, description, and a blue
"✓ On" pill. Plus an informational card with a product icon and prose.

### `photo_…722`, `…721` — Linked apps

`…722` — "Manage data sharing" with a settings gear on the right. Search field
as a **full pill** with the magnifier inside. Then *"View by:"* with **filter
chips carrying counts**: `Sign in with Google (27)`, `Access to (4) ▾`,
`Linked account (0)` — the zero one is *dimmed but still present*. Then app
rows: real favicon left, name right.

`…721` — one app's page. Title is the app's name. A card, "How Google helps you
sign in to Airtm", the provider mark, prose, a scope line with an icon, and a
**"See details" outlined pill bottom-right**. Then a separate destructive card:
"Delete all — Remove all links and stop sharing…", with a `›`.

This is the model for Vesopa's `/account/apps` and for a per-application page.

### `photo_…713`, `…714` — Wallet & subscriptions

`…714` opens with an **alert card**: orange `!` circle, bold title, prose, and
**two actions bottom-right — "Dismiss" (text) and "Update" (filled yellow
pill)**. That is the pattern for "your card failed" and for
"your Vesopa Hosting renewal failed".

An expander row: "Show more" with a **count and a chevron** in a chip on the
right.

Then plain-text section headings ("Payment methods in Google Wallet") over
action rows ("Add payment method" with an icon, "Manage payment methods" with
none), and description rows (Payments data, Subscriptions).

### `photo_…711`, `…712` — Subscriptions ★ the model for Vesopa's subscriptions

`…712` shows the state labels stacked as plain text above the list: *"Managed by
Google"*, *"Linked to your Google Account"*, *"Inactive"* — these are group
headings, one per state.

The list itself is **one bordered card containing rows separated by hairline
rules** (unlike the rest of the design, which uses gaps). Each row:

- **App icon, 56px, squared with ~12px radius** — the real product icon, in
  full colour, on its own white tile where the icon needs one.
- **Product name in the accent colour**, ~21px — it is a link.
- Plan name in white/full contrast: "Meta Verified Standard", "100 GB",
  "YouTube Premium".
- Status line, muted: "Expired on Jun 17, 2024", or a plan qualifier like
  "Family subscription".

For Vesopa this maps directly:

| Google | Vesopa |
|---|---|
| App icon | Vesopa EPOS / Kitchen / Display / Hosting / Domain / Email product mark |
| Product name (link) | The product, linking to its own page |
| Plan name | The tier or the resource: "Till × 3", "100 GB", "5 mailboxes" |
| Status | "Renews 3 Oct 2026", "Expired on…", "Cancelled — access until…" |
| Group heading | "Active", "Cancelled", "Expired" |

---

## 4. Visual specification, as measured

Taken off the 1080×2340 screenshots and converted to CSS pixels at DPR 3.

| Token | Value | Seen in |
|---|---|---|
| Product bar height | ~56px | all |
| Page title | 32px, weight 400 | `…719` |
| Row label | 19px, weight 400 | `…720` |
| Row value | 16px, muted | `…720` |
| Section heading (plain text) | 20px | `…727` |
| Row radius | 14px | all |
| Row vertical padding | 18–22px | `…720` |
| Gap between rows in a group | 4px | `…729` |
| Gap between groups | 32px | `…729` |
| Icon circle (hub) | 48px, saturated fill | `…730` |
| Icon (inside rows) | 24px, no circle | `…720` |
| Subscription app tile | 56px, radius 12px | `…711` |
| Chip button | pill, ~48px tall, 1px outline | `…726` |
| Filled action button | pill, ~52px, dark text on pale accent | `…715` |
| Loading bar | ~3px, top of viewport | `…717` |
| Body side margin | 16px | all |

**Colour discipline worth copying:** saturated colour is used only for section
identity (the hub icons) and for status (green on, blue on, orange warning,
yellow action). Everything else is greyscale. Vesopa's brand green
(`#a5c715`) should be treated the same way — it is the *action* colour, not a
decoration.

---

## 5. The faults, and which reference answers each

From `../design_mistakes/`:

| Image | Fault | Answered by |
|---|---|---|
| `…731` | Back-office sign-in: wordmark rendered ~830px wide on a 1080px screen. And "Sign in with your Vesopa account" is an underlined link in a grey box. | `…716` — small mark, top-left. Plus `Screenshot 2026-09-09 at 09.43.50.png` for the button. |
| `…733` | Homepage header wraps: "Developers Policies" on one line, "Privacy [Sign in]" on the next, crowding the wordmark. | Reference bars carry a wordmark and icons only. Move the links below the hero. |
| `…734` | `/account/linked`: one combined input plus a "What is it?" dropdown *after* it. | The toggle-then-input pattern already used on `/login`. |
| `…735`, `…736`, `…738` | Profile picture is a raw `<input type=file>` + Upload button. Tab strip cut off at "How you s…". | `…730` avatar-with-pencil; `…720` picture as a row; §1 — no tab strip on a phone. |
| `…737` | Date of birth renders as a 102px grey stub. Text cut off on the right. | `…715` — a real field with a floating label, full width. |
| `…739` | **Page scrolls sideways.** | Measured, see below. |

### The sideways scroll, measured rather than guessed

`tool/auth_overflow.py account/profile 360`, against live:

```
document scrollWidth : 431
document clientWidth : 360
OVERFLOW             : 71px

selector           width  scrollW  min-width  overflow-x   display
html                 360      431        0px     visible     block
.console             360      431       auto     visible      grid
.console-main        431      431        0px     visible     block
```

The grid column is correctly 360px, but `.console-main` is 431. Forcing
`width: min-content` on each descendant identifies the cause exactly:

```
element   class                            min-content
section   panel                                    399
div       avatar-row                               357   ← the cause
```

`.avatar-row` — the avatar, "Choose an image", the file input and the Upload
button in one non-wrapping flex row — has a 357px minimum. That sets the
panel to 399, and `.console-main` (which is `margin-inline: auto`, so it is
`fit-content` sized rather than stretched) to 399 + 32px padding = **431**.

So the profile-picture control is not merely ugly: **it is the thing making
every account page scroll sideways.** Rebuilding it fixes both complaints at
once.

The date input is a separate, smaller bug: `input[type="date"]` measures 102px
because the stylesheet's width rule does not reach it, so it falls back to its
intrinsic size.

---

## 6. What this means for Vesopa — the decisions

1. **A hub page at `/account`**, built from rows, replacing the tab strip on
   phones. Keep the rail on desktop where there is room for it.
2. **Personal info becomes a list of values**, each opening an editor page.
   One thing on screen at a time.
3. **The avatar is the control.** Click the picture, or "Change" beneath it →
   file dialog → crop dialog (square selection, zoom, circular preview) →
   resize to ≤500×500, refuse under 30×30, compress, upload. Doing the crop in
   the browser also removes the "under 2 MB" failure, because a phone photo is
   4 MB before cropping and ~60 KB after.
4. **Subscriptions** as its own section, on the `…711`/`…712` model, covering
   Vesopa EPOS, Kitchen, Display, Hosting, Domain and Email.
5. **"Continue with Vesopa"** as a proper branded button matching the Google
   and Apple buttons, published as a copy-and-paste snippet so every Vesopa
   product and every third party renders it identically.
6. **The loading bar on every screen**, including first paint — Vesopa's
   `public/js/loadbar.js` already exists and is good, but it only starts on a
   click or a submit, so a cold page load shows nothing.
7. **Nothing wider than the viewport, ever.** The measurement above should
   become a test, not a one-off.
