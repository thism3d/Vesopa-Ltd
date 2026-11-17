# Vesopa AI in Vesopa Go

*Don't just see your business. Understand it.*

A business advisor inside Go. An owner opens **Vesopa AI** from the drawer (or the ✦ button in the top bar on any screen) and sees how the business is doing, then asks questions in plain words: "Why did my sales drop yesterday?", "What stock should I reorder?", "Which branch performed best?". The answers come from the venue's own Vesopa EPOS data, with the charts and records behind them.

## On a PC or laptop: go.vesopa.com/ai

The same Vesopa AI in the browser (`vesopa_go/web/site/ai/`). Owners sign in with **Continue with Vesopa** using the email their venue is registered under. Anyone a manager invited signs in with the email the invite went to, and needs no code. The back office exchanges the sign-in code (`POST /api/go/ai/web/exchange`) and checks the session on every request, so a removed invite stops at once. Owners can also invite and remove people there. Linked from go.vesopa.com and vesopasoftware.com (the Vesopa Go section).

Deploy: `Go - server` (live) adds the page's return address to Go's Vesopa Auth client (`vesopa_auth/schema/schema_030_vesopa_go_web_ai.sql`). `Go - site` (live) uploads the page. `vesopasoftware.com - files` with `site/index.html` updates vesopasoftware.com.

## What it does

| Tab | What it shows |
|---|---|
| **Briefing** | Today so far against the same time last week, yesterday and why it moved, what needs attention, what to do next |
| **Ask** | Questions in plain words, follow-ups ("and yesterday?"), suggested questions, conversation history (kept on this device only) |
| **Sales** | Takings, sales and average spend with comparisons, why revenue moved (number of sales against spend per sale, products, hours, sites, staff), busiest hours |
| **Profit** | Gross profit and margin, most profitable products, best sellers, products selling below cost, products with no cost price |
| **Stock** | Days of stock left, the date each product runs out, suggested reorder amounts, fast and slow movers |
| **People** | Sales by member of staff, branch comparison (or tills when the venue has no sites) |

Every answer carries its reporting period, the comparison period, the branch, what each figure means ("Definitions"), how fresh the data is (the latest sale received) and **View data**, which opens the rows behind it.

## How it stays accurate

1. **The server counts; the model explains.** `vesopa_server/src/go_advisor_engine.js` works out every figure from SQL rows. `go_advisor_answers.js` builds the answer and its plain-English wording from those figures. Every answer works with no model at all.
2. **A model only re-words.** When a model is configured, it is given the computed facts and asked to explain them. Every number in its reply is checked against the facts (`checkNarrative`). A reply quoting a figure that isn't there is discarded, and the plain wording is shown with a note saying so.
3. **No personal data to the model.** Staff names are sent as "Staff A", "Staff B" and put back on the server. Customer data is never read. This follows the AI policy in `shared/ai-client/vesopa_ai.js`: DeepSeek, Gemini as backup, a daily spending cap and usage logging.
4. **Read-only.** Nothing in Vesopa AI changes a record. A request such as "change the price of lager" is answered with where a manager does that and who approves it.

## Who may use it

- **Managers:** staff in no permission group, or in a group with *Is manager*. This is the same rule as every other manager check on the server. They are let in automatically with the PIN they signed on with.
- **Invited people:** a manager opens **⋮ → Invite people**, types an email address and chooses every site or one site. The person gets an 8-character code by email. On Go, signed on with their own staff PIN, they tap **I have an invite code**. Each code works once and expires in 14 days. Revoking an invite takes effect on their next request. Only a hash of the code is stored. If the server can't send email, the manager is shown the code to pass on in person.
- **Branch permissions:** an invite for one site is locked to it. The server filters every query to that site's tills and refuses any other site.
- **Tenant isolation:** every statement binds the venue first (`o.email = ?` / `office = ?`). `test/tenancy.test.js` sweeps the new files too.
- Hidden in the demo: it needs a real business.

## Setting it up (live server)

1. Run `vesopa_server/schema/schema_go_ai.sql`. It creates `go_ai_invites` and can be re-run safely.
2. Optional, for the AI wording: set `DEEPSEEK_API_KEY` (and `GEMINI_API_KEY` as the backup), `AI_DAILY_CAP_USD` (default 5) and `AI_LOG_DIR`. With no key, every figure, chart and recommendation still works, and the app says the explanations are plain wording.
3. Invite email uses the server's existing SMTP settings (`src/mailer.js`).
4. Deploy the back office as usual, then release Go.

## Known gaps (stated, not hidden)

- **Supplier lead times aren't stored anywhere**, so reorder suggestions cover 14 days at the 28-day sales rate. The app says to allow for delivery.
- **Stock is venue-wide** (`bo_products`), not per site. The app says so when a site is chosen.
- **Cost** is today's product cost price times quantity (the usual "notional" cost, the same as the back office's GP reports). Products with no cost price are left out of profit and shown as "Not costed".
- **No labour cost in staff figures yet.** Clock-in and wage data exists in the back office's staff reports and could be added.
- **Invited people must be staff** with a PIN at the venue. A non-staff viewer, such as an accountant, would need a separate sign-in.
- **Actions that change records** (for example, drafting a purchase order) are not built. When they are, each needs a manager's approval before anything is written.

## Code

| Where | What |
|---|---|
| `vesopa_server/src/go_advisor.js` | Routes, access, scoped SQL, AI wording and its checks, invites |
| `vesopa_server/src/go_advisor_engine.js` | Periods, sales, why-it-changed, profit, stock forecast, staff, alerts, question parsing |
| `vesopa_server/src/go_advisor_answers.js` | One answer per kind of question: headline, reasons, cards, definitions |
| `vesopa_server/test/go-advisor.test.js` | 21 checks. `ADVISOR_FIXTURES=../vesopa_go/test/fixtures/advisor node test/go-advisor.test.js` refreshes Go's fixtures |
| `vesopa_go/lib/advisor/` | Session and history (`advisor_state.dart`), the page and tabs, answer view, charts and tables in Go's own style |
| `vesopa_go/test/advisor_test.dart` | 9 tests against the server's real responses, at phone and desktop width |

Routes: `POST /api/go/ai/session`, `POST /api/go/ai/invites/redeem`, `GET /api/go/ai/briefing`, `POST /api/go/ai/ask`, `GET /api/go/ai/records`, `GET|POST /api/go/ai/invites`, `DELETE /api/go/ai/invites/:id`. Each needs Go's terminal token. All but the first two also need the Vesopa AI session (`X-Vesopa-AI` header).
