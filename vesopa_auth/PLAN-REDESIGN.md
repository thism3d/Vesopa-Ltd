# The redesign, and one sign-in for every Vesopa product

The plan of record for this piece of work. `OAuthTasksWithProperStructureInfo.md`
still governs the architecture; this governs what is being changed now and why.
`reference_design/VesopaOauthReference.md` is the measured specification the
visual work is built against — where this file and that one disagree about a
pixel, that one wins.

Status: `[x]` done and proven on the live server · `[~]` partly done · `[ ]` not started

**Where it got to.** Everything except two items, both noted below: the
personal-info page is still one form rather than a list of values opening
editor pages (C2/C4 — the sideways scroll it caused IS fixed), and the loading
bar still starts on a click rather than on first paint (C5).

---

## 0. The one thing that is not a task

**The shared password is public.** `github.com/thism3d/Vesopa-Ltd` is a public
repository and `vesopasoftware/server/seed.js` carried the admin and customer
password as a plain-text constant. It is out of the working tree now, but it is
in the git history, which is public too — so it must be treated as compromised
and **rotated**: the `vesopasoftware_authuser` database password, the
`info@vesopasoftware.com` login, and the mail accounts. No amount of code
fixes that; only changing the password does.

---

## 1. What is being built, in one paragraph

Every Vesopa product stops having a login of its own. The menu, the back office
and the till each get exactly one way in — **Continue with Vesopa** — and
everything that used to be a password box in those products becomes a round
trip to `auth.vesopa.com`. On that one sign-in page the behaviour becomes
**identifier first, then password, with a code as the way out from under it**,
and which of those a given application offers is a per-application setting an
administrator controls. The account area is rebuilt to the Google Account shape
the reference documents, gains subscriptions and payment methods, and stops
scrolling sideways. Desktop applications get the flow a person already knows
from signing in to VS Code with Google.

---

## 2. The tasks

### A — Foundations · schema and settings

- [x] **A1** `schema_008_auth_policy.sql` — per-application sign-in policy.
      `application_auth_methods` (application_id, method, enabled, sort) where
      method is one of `password`, `code_email`, `code_sms`, `passkey`,
      `google`, `microsoft`, `apple`, `github` — **rows, not columns**, so a
      provider added next year is an INSERT and not a migration.
      Plus `applications.auth_policy` (`password_first` | `code_first` |
      `provider_only`) and `applications.show_consent` (so consent can be
      demanded even of a first-party app).
- [x] **A2** `schema_009_billing.sql` — `subscriptions`, `subscription_items`,
      `payment_methods`. Cards are **recorded, never charged**: brand, last
      four, expiry, and the provider's token. No PAN, no CVV, no authorisation
      code — that is a later piece of work and the schema must not invite it.
- [x] **A3** Settings gain the global defaults: `auth_policy_default`,
      `captcha_enabled`, `captcha_site_key`, `captcha_threshold`,
      `signin_wordmark_size`. Everything an administrator can set globally, an
      application can override.

### B — The sign-in flow rebuilt

- [x] **B1** **Identifier first.** One field. Submit finds the person, then the
      page becomes "Hi <name>" with an account chip and the strongest method
      they actually hold. Never says whether an address is known before that
      point — the answer is the same page either way.
- [x] **B2** **Password, with a way out.** Where the application asks for a
      password and the person has one, that is the field. Underneath, a text
      link: **"Email me a code instead"** — the phrasing is deliberate; "Login
      using OTP" is jargon most diners have never met.
- [x] **B3** **reCAPTCHA v3** on `/login`, on the code send, and on the password
      check. Score-based and invisible; below the threshold it does not refuse,
      it demands a code — a refusal on a wrong guess about a human is a person
      locked out of their own account. Off when no site key is configured.
- [x] **B4** Provider buttons come from the application's `auth_methods`, not
      from what the server happens to have credentials for.
- [x] **B5** The wordmark on the sign-in page is **~40px tall, top-left**, not
      830px wide. `design_mistakes/…731`.

### C — The account area, to the reference

- [x] **C1** `/account` becomes the **hub**: identity card with the avatar
      carrying a pencil badge, then colour-grouped rows. No tab strip on a
      phone; the rail stays on desktop.
- [~] **C2** `/account/profile` becomes a **list of values**, each opening its
      own editor page. One thing on screen at a time.
- [x] **C3** **The avatar is the control** — click the picture, choose, crop in
      the browser, upload. This also removes `.avatar-row`, which is the thing
      making every account page scroll sideways (measured: 357px min-content).
- [~] **C4** The floating-label field from `…715`, and a date input that is not
      a 102px stub.
- [ ] **C5** The loading bar on **first paint**, not only on a click.
- [x] **C6** A test that no page is wider than its viewport, at 360px.

### D — Images and first impression

- [x] **D1** Generate the hero and section imagery with Gemini
      (`gemini-3-pro-image`), in Vesopa's palette. Stored locally and served
      from this origin — the CSP allows no third-party images, and the sign-in
      domain is the last place to make an exception.
- [x] **D2** Rebuild the landing page around it: hero, what it is, the products
      it signs you into, developers, policies. Fix the header that wraps
      "Privacy [Sign in]" onto a second line (`…733`).
- [x] **D3** A **"Continue with Vesopa" button**, matching the Google and Apple
      buttons the owner supplied, published as a copy-and-paste snippet so every
      product renders it identically.

### E — Subscriptions and payment methods

- [x] **E1** `/account/subscriptions` on the `…711`/`…712` model: grouped by
      state, product tile, product name in the accent colour, plan, status line.
- [x] **E2** `/account/wallet` — payment methods listed, the alert card from
      `…714` for a failed renewal. **Cards are recorded, never charged.**
- [x] **E3** Seed the six Vesopa products so the page is real: EPOS, Kitchen,
      Display, Hosting, Domain, Email.

### F — Consent

- [x] **F1** Every application shows the consent screen when
      `show_consent` is set, first-party included. The screen gains the app's
      logo, the organisation, and per-scope wording it already has.

### G — One sign-in in the products

- [x] **G1** **Menu** — the Vesopa button above "Continue as guest", with the
      Vesopa mark, as drawn. Guest stays the default and stays first-class.
- [x] **G2** **Back office** — Vesopa Auth and nothing else. The local password
      form goes.
- [x] **G3** **EPOS till** — device sign-in, below.

### H — How a desktop application connects

The flow the owner described, which is the one VS Code uses with Google:

- [x] **H1** The app shows **Continue with Vesopa** and opens the system
      browser. It listens on `http://127.0.0.1:<port>/callback` — RFC 8252
      loopback, already allowed for `native` clients.
- [x] **H2** The browser shows the account chooser and the consent screen; the
      person picks an account and continues.
- [x] **H3** The browser lands on **a page on this origin** that says it worked
      and offers to hand back to the application — the "open the app?" dialog
      the browser raises for a custom scheme, with a visible button behind it in
      case they dismiss it.
- [x] **H4** The app exchanges the code, stores the refresh token, and is
      linked. Revoking it under `/account/apps` kills the refresh token family,
      so the app finds itself unauthenticated and asks again — which is exactly
      the behaviour asked for.
- [x] **H5** `smoke-device-flow.js` drives it end to end.

### I — Finishing

- [x] **I1** Every suite green on the live domain.
- [x] **I2** The EPOS sign-in driven in a real browser, start to finish.
- [x] **I3** `README.md` rewritten to describe what exists.
- [x] **I4** Committed and pushed.

---

## 3. Decisions taken here, and why

**Sign-in methods are rows, not columns.** `application_auth_methods` costs a
join and buys the owner's actual requirement: *"or anything that comes later,
keep the scope open."* A boolean column per provider means a schema migration
every time somebody adds one, and a form that has to be edited to match.

**A low captcha score never refuses anybody.** reCAPTCHA v3 returns a
probability, and a threshold applied as a gate locks real people out of their
own accounts on a bad day — a shared office IP, a privacy browser, a VPN. Below
the threshold this asks for an emailed code instead. The bot does not have the
mailbox; the person does.

**Cards are recorded and never charged.** The owner was explicit that
authorisation comes later. So the schema holds a brand, four digits, an expiry
and a provider token, and there is no code path that could take money — because
a half-built payment path is the one that takes money by accident.

**The consent screen can be demanded of first-party applications.** It is
currently skipped for them, which is normal and defensible. The owner asked for
consent on every authorisation, and being able to see what the till is asking
for is worth more than one saved tap.

**Guest ordering is untouchable.** It is repeated here because it is the thing
most likely to be broken by accident while doing everything else on this list.
