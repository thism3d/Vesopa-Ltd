const express = require('express');
const jwt = require('jsonwebtoken');

const G = require('./wallet_google');

/**
 * The pages a wallet card links out to.
 *
 * WHY THESE EXIST
 *
 * A pass is a card, and a card has room for about six facts. Everything a
 * customer might reasonably want to know beyond that — what their points are
 * actually worth, how far off the next reward they are, what the tier above
 * theirs gets them, what is on this week — has nowhere to go on the front and
 * reads as an essay on the back.
 *
 * So the card carries the six facts and links here for the rest. iOS 27 draws
 * those links as tiles under the card face (`featuredActions`); every older iOS
 * ignores that key entirely, which is why the same links are *also* plain URL
 * fields on the back of the pass. A tappable back field has worked since the
 * format existed, so nobody is waiting for an OS release to reach these pages.
 *
 * WHO IS LOOKING
 *
 * Nobody signed in. The link carries the same signed token the QR code does —
 * scope `wallet`, naming an office, a kind and a subject — so possession of the
 * card is the credential, exactly as it is for the pass itself. That is the
 * right model for a page reached by tapping a card in your own wallet, and it
 * is why none of these pages will do anything but *show* you something: there
 * is no action here that a stranger holding a found phone should be able to
 * take.
 *
 * WHY THEY ARE NOT THE VENUE'S HOMEPAGE
 *
 * The obvious shortcut is to point all four at `brand.homepage_url` and be done.
 * That is worse than no link: four differently-labelled tiles that all land on
 * the same marketing page teach a customer that the card's buttons do nothing.
 * Each of these answers the question its own tile asks, from the venue's own
 * data, and a venue that has filled nothing in gets a page that says so plainly
 * rather than an empty frame.
 */
function walletPageRoutes({ pool, secret, core }) {
  const router = express.Router();
  const { readBrand, loadSubject } = core;

  /**
   * Resolve a card link, or explain why it will not open.
   *
   * [wantKind] is checked rather than trusted: a token minted for a gift card
   * must not open the membership page, because the two carry different facts
   * about the same person and the link is public.
   */
  async function open(req, res, wantKind) {
    let claims;
    try {
      claims = jwt.verify(String(req.params.token), secret);
    } catch {
      res.status(400).type('html').send(
        shell(
          {},
          'This link has expired',
          '<p class="muted">Open the card in your wallet again to get a fresh one.</p>'
        )
      );
      return null;
    }

    if (claims.scope !== 'wallet' || (wantKind && claims.kind !== wantKind)) {
      res.status(400).type('html').send(shell({}, 'Not a card link', ''));
      return null;
    }

    const brand = await readBrand(claims.office);
    const subject = await loadSubject(claims.office, claims.kind, claims.sub).catch(() => null);
    if (!subject) {
      res.status(404).type('html').send(
        shell(brand, 'That card was not found', '<p class="muted">Ask a member of staff.</p>')
      );
      return null;
    }
    return { office: claims.office, kind: claims.kind, brand, subject };
  }

  /** A venue's loyalty rules, which are what make the numbers below mean anything. */
  async function loyaltyRules(office) {
    try {
      const [[row]] = await pool.query(
        'SELECT * FROM epos_loyalty_settings WHERE office = ?',
        [office]
      );
      const [tiers] = await pool.query(
        `SELECT name, min_spend_minor, discount_type, discount_value
           FROM epos_loyalty_tiers
          WHERE office = ? AND active = 1
          ORDER BY min_spend_minor ASC`,
        [office]
      );
      return { settings: row || null, tiers: tiers || [] };
    } catch {
      // A venue that predates the loyalty tables still gets a page; it just
      // shows the balance without the arithmetic around it.
      return { settings: null, tiers: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // Loyalty: what the points are worth
  // ---------------------------------------------------------------------------

  router.get('/wallet/rewards/:token', async (req, res, next) => {
    try {
      const found = await open(req, res, 'loyalty');
      if (!found) return;
      const { brand, subject } = found;
      const { settings, tiers } = await loyaltyRules(found.office);

      const points = Number(subject.points) || 0;
      const reward = rewardProgress(points, settings);

      const body = [
        bigNumber(points.toLocaleString('en-GB'), 'POINTS'),
        reward.worth
          ? `<p class="lead">Worth <strong>${escapeHtml(reward.worth)}</strong> off your bill.</p>`
          : '',
        reward.bar,
        section('How you earn', brand.earning_text ||
          (settings ? `${Number(settings.points_per_pound) || 1} point for every £1 you spend.` : '')),
        section('How you spend', brand.redeeming_text ||
          (settings && Number(settings.min_redeem_points)
            ? `Redeem from ${Number(settings.min_redeem_points)} points at the till.`
            : '')),
        tierTable(tiers, subject.tier),
        section('Your tier', brand.tier_text),
        section('Points expiry', brand.expiry_text),
        ledger(subject.history),
        venueFooter(brand),
      ].join('');

      res.type('html').send(shell(brand, 'Your rewards', body, subject.name));
    } catch (e) {
      next(e);
    }
  });

  // ---------------------------------------------------------------------------
  // Membership: who they are here
  // ---------------------------------------------------------------------------

  router.get('/wallet/member/:token', async (req, res, next) => {
    try {
      const found = await open(req, res, 'customer');
      if (!found) return;
      const { brand, subject } = found;
      const { tiers } = await loyaltyRules(found.office);

      const body = [
        subject.member_no
          ? bigNumber(escapeHtml(String(subject.member_no).padStart(4, '0')), 'MEMBER NUMBER')
          : '',
        `<dl class="facts">
           ${fact('Member', subject.name)}
           ${fact('Tier', subject.tier)}
           ${fact('Your discount', subject.discount)}
           ${fact('Member since', subject.member_since)}
         </dl>`,
        tierTable(tiers, subject.tier),
        section('Your tier', brand.tier_text),
        venueFooter(brand),
      ].join('');

      res.type('html').send(shell(brand, 'Your membership', body, subject.name));
    } catch (e) {
      next(e);
    }
  });

  // ---------------------------------------------------------------------------
  // Gift card: the balance, and how to put more on it
  // ---------------------------------------------------------------------------

  router.get('/wallet/balance/:token', async (req, res, next) => {
    try {
      const found = await open(req, res, 'giftcard');
      if (!found) return;
      const { brand, subject } = found;

      // The spend, if the card has one. Read here rather than in loadSubject
      // because it is the only page that wants it and a pass has no room for a
      // ledger it cannot scroll.
      let movements = [];
      try {
        const [rows] = await pool.query(
          `SELECT kind, amount_minor, balance_after, created_at
             FROM epos_gift_card_txns
            WHERE gift_card_id = (SELECT id FROM epos_gift_cards
                                   WHERE office = ? AND code = ? LIMIT 1)
            ORDER BY created_at DESC LIMIT 20`,
          [found.office, subject.card_number]
        );
        movements = rows || [];
      } catch {
        movements = [];
      }

      const loaded = movements
        .filter((m) => m.kind === 'issue' || m.kind === 'reload')
        .reduce((sum, m) => sum + (Number(m.amount_minor) || 0), 0);

      const body = [
        bigNumber(money(subject.balance_minor, subject.currency), 'BALANCE'),
        loaded
          ? `<p class="lead">of ${escapeHtml(money(loaded, subject.currency))} loaded onto this card.</p>`
          : '',
        `<dl class="facts">
           ${fact('Card', subject.card_number ? maskCard(subject.card_number) : '')}
           ${fact('For', subject.name)}
           ${fact('Expires', subject.expires_on)}
         </dl>`,
        // Honest about what this page can and cannot do. Taking a payment here
        // would be a new payment surface on an unauthenticated page reached from
        // a card in a stranger's pocket; topping up at the counter is how these
        // cards are loaded today and the page says so rather than pretending.
        section(
          'Topping up',
          `Hand the card — or this screen — to a member of staff at ${
            brand.issuer_name || 'the counter'
          } and they can add to it. The balance here updates as soon as they do.`
        ),
        giftLedger(movements, subject.currency),
        venueFooter(brand),
      ].join('');

      res.type('html').send(shell(brand, 'Your gift card', body, subject.name));
    } catch (e) {
      next(e);
    }
  });

  // ---------------------------------------------------------------------------
  // Offers: what is on
  // ---------------------------------------------------------------------------

  router.get('/wallet/offers/:token', async (req, res, next) => {
    try {
      // Any card opens this one. An offer is not about the holder — it is what
      // the venue has on this week — so a loyalty card, a gift card and a
      // membership all reach the same page, and requiring a promo token would
      // mean only the people already holding an offer could see the offers.
      const found = await open(req, res, null);
      if (!found) return;
      const { brand } = found;

      let offers = [];
      try {
        const [rows] = await pool.query(
          `SELECT name, badge_text, kind, value, ends_on
             FROM epos_promotions
            WHERE office = ? AND active = 1
              AND (starts_on IS NULL OR starts_on <= CURDATE())
              AND (ends_on   IS NULL OR ends_on   >= CURDATE())
            ORDER BY ends_on IS NULL, ends_on ASC
            LIMIT 20`,
          [found.office]
        );
        offers = rows || [];
      } catch {
        offers = [];
      }

      const list = offers.length
        ? `<ul class="offers">${offers
            .map(
              (o) => `<li>
                <strong>${escapeHtml(o.badge_text || o.name)}</strong>
                ${o.badge_text && o.name !== o.badge_text
                  ? `<em>${escapeHtml(o.name)}</em>` : ''}
                ${o.ends_on
                  ? `<span class="until">Until ${escapeHtml(day(o.ends_on))}</span>` : ''}
              </li>`
            )
            .join('')}</ul>`
        : `<p class="muted">Nothing on just now. Worth checking back — offers are
             added from the till, so this page is never out of date.</p>`;

      const body = [
        list,
        brand.homepage_url
          ? `<p class="cta"><a href="${escapeHtml(brand.homepage_url)}">
               See the full menu</a></p>`
          : '',
        venueFooter(brand),
      ].join('');

      res.type('html').send(shell(brand, "What's on", body));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

/**
 * How far off the next reward, and what the balance is worth.
 *
 * Real numbers from `epos_loyalty_settings` rather than a slogan: a venue sets
 * `min_redeem_points` and `point_value_minor`, and those two together are the
 * only honest answer to "what are my points for". A card that says "collect
 * points!" and cannot say what for is the reason people stop collecting.
 */
function rewardProgress(points, settings) {
  if (!settings) return { worth: '', bar: '' };

  const value = Number(settings.point_value_minor) || 0;
  const floor = Number(settings.min_redeem_points) || 0;
  const worth = value ? money(points * value, 'GBP') : '';

  if (!floor) return { worth, bar: '' };

  if (points >= floor) {
    return {
      worth,
      bar: `<p class="ready">Ready to spend — ask at the till.</p>`,
    };
  }

  const togo = floor - points;
  const pct = Math.max(0, Math.min(100, Math.round((points / floor) * 100)));
  return {
    worth,
    bar: `<div class="prog"><div class="prog-bar" style="width:${pct}%"></div></div>
          <p class="togo"><strong>${togo.toLocaleString('en-GB')}</strong> more
            ${togo === 1 ? 'point' : 'points'} until you can spend them.</p>`,
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const money = (minor, currency) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: currency || 'GBP',
  }).format((Number(minor) || 0) / 100);

const day = (value) => {
  if (!value) return '';
  const when = new Date(value);
  return Number.isNaN(when.getTime())
    ? String(value)
    : when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
};

/** A gift card number, masked. The whole number belongs in the barcode. */
const maskCard = (value) => {
  const digits = String(value || '');
  return digits.length <= 4 ? digits : `···· ${digits.slice(-4)}`;
};

const bigNumber = (value, label) =>
  `<div class="hero"><span class="hero-label">${escapeHtml(label)}</span>
     <span class="hero-value">${value}</span></div>`;

const fact = (label, value) =>
  value ? `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>` : '';

/** A block of the venue's own words, or nothing at all when they have none. */
const section = (heading, text) =>
  text ? `<section><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(String(text))}</p></section>` : '';

function tierTable(tiers, current) {
  if (!tiers || tiers.length < 2) return '';
  return `<section><h2>Tiers</h2><ul class="tiers">${tiers
    .map((t) => {
      const mine = current && String(current) === String(t.name);
      const perk =
        t.discount_type === 'percent'
          ? `${t.discount_value}% off`
          : t.discount_type === 'amount'
            ? `${money(t.discount_value, 'GBP')} off`
            : '';
      return `<li${mine ? ' class="mine"' : ''}>
        <strong>${escapeHtml(t.name)}</strong>
        ${perk ? `<span>${escapeHtml(perk)}</span>` : ''}
        ${mine ? '<em>You are here</em>' : ''}
      </li>`;
    })
    .join('')}</ul></section>`;
}

function ledger(history) {
  const rows = (history || []).filter((h) => h && h.at).slice(0, 12);
  if (!rows.length) return '';
  const WORD = { earn: 'Earned', redeem: 'Spent', adjust: 'Adjusted', expire: 'Expired' };
  return `<section><h2>Recent points</h2><ul class="ledger">${rows
    .map(
      (h) => `<li>
        <span>${escapeHtml(WORD[h.kind] || h.kind)}</span>
        <b class="${Number(h.points) < 0 ? 'down' : 'up'}">${
          Number(h.points) > 0 ? '+' : ''
        }${escapeHtml(String(h.points))}</b>
        <i>${escapeHtml(day(h.at))}</i>
      </li>`
    )
    .join('')}</ul></section>`;
}

function giftLedger(movements, currency) {
  if (!movements || !movements.length) return '';
  const WORD = { issue: 'Issued', reload: 'Topped up', redeem: 'Spent', refund: 'Refunded' };
  return `<section><h2>Recent spend</h2><ul class="ledger">${movements
    .slice(0, 12)
    .map(
      (m) => `<li>
        <span>${escapeHtml(WORD[m.kind] || m.kind)}</span>
        <b class="${Number(m.amount_minor) < 0 ? 'down' : 'up'}">${escapeHtml(
          money(Math.abs(Number(m.amount_minor) || 0), currency)
        )}</b>
        <i>${escapeHtml(day(m.created_at))}</i>
      </li>`
    )
    .join('')}</ul></section>`;
}

/** Where the venue is and when it is open — the two facts a card cannot hold. */
function venueFooter(brand) {
  const bits = [
    brand.address_text ? `<p>${escapeHtml(brand.address_text)}</p>` : '',
    brand.hours_text ? `<p>${escapeHtml(brand.hours_text)}</p>` : '',
    brand.support_phone
      ? `<p><a href="tel:${escapeHtml(String(brand.support_phone).replace(/\s+/g, ''))}">${escapeHtml(
          brand.support_phone
        )}</a></p>`
      : '',
  ]
    .filter(Boolean)
    .join('');
  return bits ? `<footer>${bits}</footer>` : '';
}

/**
 * The page around all four.
 *
 * One stylesheet, inline, no external anything. These are opened by tapping a
 * card in a wallet — which on a phone means a captive venue wifi or one bar of
 * mobile data, and a stylesheet that has not arrived is a page of unstyled
 * facts about somebody's balance.
 *
 * The palette is the one in public/style.css and on the cards themselves: lime
 * on near-black, paper for text. A fifth colour here would be a fifth colour
 * the customer has not seen on the card they just tapped.
 */
function shell(brand, title, body, who) {
  const name = escapeHtml(brand.issuer_name || 'Your card');
  const logo = /^https:\/\//i.test(brand.logo_url || '') ? brand.logo_url : '';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#111111">
<title>${escapeHtml(title)} — ${name}</title>
<style>
  :root{color-scheme:dark;--lime:#a5c715;--lime-on-dark:#b7db2a;--ink:#10130a;
        --ground:#111111;--paper:#F2F4F0;--rail:#9c9c9a;--panel:#181a15}
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--paper);padding:0 0 48px;
       font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:32rem;margin:0 auto;padding:24px 20px}
  header{display:flex;align-items:center;gap:12px;margin-bottom:22px}
  header img{max-height:38px;max-width:140px;width:auto;object-fit:contain}
  header .who{font-size:.82rem;color:var(--rail);margin:2px 0 0}
  header h1{font-size:1.05rem;margin:0;font-weight:600;letter-spacing:.01em}
  .hero{background:var(--panel);border:1px solid #24271d;border-radius:16px;
        padding:22px;text-align:center;margin-bottom:16px}
  .hero-label{display:block;font-size:.66rem;letter-spacing:.12em;color:var(--lime);
              text-transform:uppercase;margin-bottom:6px}
  .hero-value{display:block;font-size:2.8rem;line-height:1.05;font-weight:700;
              font-variant-numeric:tabular-nums}
  .lead{margin:0 0 16px;text-align:center;color:var(--rail);font-size:.95rem}
  .lead strong{color:var(--paper)}
  .prog{height:6px;background:#24271d;border-radius:99px;overflow:hidden;margin:4px 0 10px}
  .prog-bar{height:100%;background:var(--lime);border-radius:99px}
  .togo{margin:0 0 20px;text-align:center;font-size:.92rem;color:var(--rail)}
  .togo strong{color:var(--lime-on-dark)}
  .ready{margin:0 0 20px;text-align:center;color:var(--ink);background:var(--lime);
         border-radius:10px;padding:10px;font-weight:600}
  section{margin:0 0 20px}
  h2{font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--lime);
     margin:0 0 7px;font-weight:600}
  section p{margin:0;color:var(--paper);font-size:.95rem}
  .muted{color:var(--rail)}
  dl.facts{display:grid;grid-template-columns:auto 1fr;gap:7px 16px;margin:0 0 22px}
  dl.facts dt{color:var(--rail);font-size:.85rem}
  dl.facts dd{margin:0;text-align:right;font-size:.95rem}
  ul{list-style:none;margin:0;padding:0}
  .tiers li{display:flex;align-items:baseline;gap:8px;padding:9px 12px;border-radius:10px;
            background:var(--panel);margin-bottom:6px;font-size:.92rem}
  .tiers li span{color:var(--rail);margin-left:auto}
  .tiers li.mine{background:rgba(165,199,21,.13);border:1px solid rgba(165,199,21,.35)}
  .tiers li em{font-style:normal;color:var(--lime-on-dark);font-size:.75rem;margin-left:auto}
  .tiers li.mine span{margin-left:0}
  .ledger li{display:flex;align-items:baseline;gap:10px;padding:8px 0;
             border-bottom:1px solid #1e211a;font-size:.9rem}
  .ledger li:last-child{border-bottom:0}
  .ledger b{margin-left:auto;font-variant-numeric:tabular-nums}
  .ledger b.up{color:var(--lime-on-dark)}
  .ledger b.down{color:var(--rail)}
  .ledger i{font-style:normal;color:var(--rail);font-size:.8rem;min-width:5.2rem;text-align:right}
  .offers li{background:var(--panel);border-radius:12px;padding:14px;margin-bottom:8px}
  .offers li strong{display:block;font-size:1.02rem}
  .offers li em{display:block;font-style:normal;color:var(--rail);font-size:.88rem;margin-top:2px}
  .offers .until{display:block;color:var(--lime-on-dark);font-size:.78rem;margin-top:6px}
  .cta{margin:18px 0 0;text-align:center}
  .cta a{display:inline-block;padding:12px 22px;border-radius:10px;background:var(--lime);
         color:var(--ink);text-decoration:none;font-weight:600}
  footer{margin-top:28px;padding-top:18px;border-top:1px solid #1e211a;
         color:var(--rail);font-size:.85rem;text-align:center}
  footer p{margin:0 0 4px}
  footer a{color:var(--lime-on-dark)}
</style></head><body><div class="wrap">
<header>
  ${logo ? `<img src="${escapeHtml(logo)}" alt="">` : ''}
  <div><h1>${escapeHtml(title)}</h1>${who ? `<p class="who">${escapeHtml(who)} · ${name}</p>` : `<p class="who">${name}</p>`}</div>
</header>
${body}
</div></body></html>`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/**
 * Where each kind of card links, and what the tile is called.
 *
 * The `type` values are Apple's own vocabulary for `featuredActions`. A staff
 * card has no entry and gets no tiles: there is nothing here a member of staff
 * needs and a rewards page on a work card is noise.
 */
const PAGE_FOR = {
  loyalty: { path: 'rewards', type: 'membershipBenefits', label: 'Your rewards' },
  customer: { path: 'member', type: 'viewMembership', label: 'Your membership' },
  giftcard: { path: 'balance', type: 'reload', label: 'Balance and top-up' },
  promo: { path: 'offers', type: 'viewOffers', label: "What's on" },
  staff: null,
};

/**
 * The link for one card, absolute, or '' when this kind has no page.
 *
 * Absolute because it is opened from a pass rather than from a page: there is
 * no document for a relative URL to be relative to.
 */
function pageLink(kind, token) {
  const page = PAGE_FOR[kind];
  if (!page || !token) return '';
  const base = String(process.env.BACKOFFICE_URL || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/wallet/${page.path}/${encodeURIComponent(token)}`;
}

module.exports = { walletPageRoutes, PAGE_FOR, pageLink, rewardProgress, shell };
