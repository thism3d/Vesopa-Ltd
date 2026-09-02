const jwt = require('jsonwebtoken');

/**
 * The Google Wallet half of the pass system: credentials, the REST client, the
 * four pass templates and the signed "Add to Google Wallet" link.
 *
 * Deliberately free of express and of the database. Everything here is a pure
 * function of its arguments plus, at the edges, an HTTP call — which is what
 * makes it testable without an issuer account, and what let the whole of this
 * file be verified before the service-account key existed.
 *
 * Vocabulary, because Google's two nouns are easy to swap by accident:
 *
 *   class   the template. One per office per kind. Holds the programme name,
 *           the logo, the terms. Changing it changes every card already in
 *           every customer's phone, which is the point.
 *   object  one person's card. Holds their name, their points, their barcode.
 *           Points at a class.
 *
 * There are two ways to get a card into a phone and this module supports both:
 *
 *   by reference  the class and object are created at Google over REST first,
 *                 and the link carries only the object's id. The link stays
 *                 short. This is the normal path.
 *   inline        the whole class and object travel inside the signed link and
 *                 Google creates them on first save. No REST call, no OAuth —
 *                 useful before the service account has issuer permission, and
 *                 the only path that works if walletobjects is unreachable.
 *                 The link gets long, and past ~1800 characters browsers
 *                 truncate it, so this is a fallback and not the default.
 */

const WALLET_API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SAVE_PREFIX = 'https://pay.google.com/gp/v/save/';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

// Google truncates nothing itself; browsers do. Anything past this and the
// save link may arrive at pay.google.com incomplete, which presents as a
// blank "something went wrong" page with no clue as to why.
const SAFE_JWT_LENGTH = 1800;

/**
 * The five passes this system issues, stated once.
 *
 * One row per kind, carrying both halves of the world: what Apple calls it and
 * what Google calls it. They are registered together because they are the same
 * decision — "a gift card" is one product, and having its Apple identifier in
 * a plist, its Google resource in this file and its label in a template is how
 * the three drift apart.
 *
 *   appleType   the pass type identifier registered at developer.apple.com.
 *               Fixed for the life of the certificate: changing it invalidates
 *               every pass already in every phone, so these are effectively
 *               permanent.
 *   appleStyle  Apple's pass style. `storeCard` for anything with a balance or
 *               a scheme behind it, `coupon` for an offer with an end date,
 *               `generic` for identity.
 *   classResource / objectResource   the Google Wallet REST resources.
 *   payloadKey  the key this kind takes inside a save JWT.
 *
 * Note where the two platforms disagree, because it is not a mistake:
 * membership and staff are both `storeCard`/`generic` on Apple but both land
 * on Google's `genericClass`, and loyalty and gift card are both `storeCard`
 * on Apple while Google gives each its own resource. Apple models the *shape*
 * of the card; Google models what it is *for*.
 */
const PASS_TYPES = {
  loyalty: {
    label: 'Loyalty Card',
    appleType: 'pass.com.vesopa.loyalty',
    appleStyle: 'storeCard',
    appleCertFile: 'loyalty_pass.cer',
    classResource: 'loyaltyClass',
    objectResource: 'loyaltyObject',
    payloadKey: 'loyaltyObjects',
  },
  // "Membership" to a customer, `customer` in this codebase since before the
  // Apple identifiers existed. The internal name is not worth a rename across
  // four tables and a settings screen; the label is what anybody sees.
  customer: {
    label: 'Membership Card',
    appleType: 'pass.com.vesopa.membership',
    appleStyle: 'storeCard',
    appleCertFile: 'membership_pass.cer',
    classResource: 'genericClass',
    objectResource: 'genericObject',
    payloadKey: 'genericObjects',
  },
  giftcard: {
    label: 'Gift Card',
    appleType: 'pass.com.vesopa.giftcard',
    appleStyle: 'storeCard',
    appleCertFile: 'giftcard_pass.cer',
    classResource: 'giftCardClass',
    objectResource: 'giftCardObject',
    payloadKey: 'giftCardObjects',
  },
  staff: {
    label: 'Staff Card',
    appleType: 'pass.com.vesopa.staff',
    appleStyle: 'generic',
    appleCertFile: 'staffcard_pass.cer',
    classResource: 'genericClass',
    objectResource: 'genericObject',
    payloadKey: 'genericObjects',
  },
  promo: {
    label: 'Promotion',
    // `promotions`, plural, and not a typo. The certificate Apple issued says
    // pass.com.vesopa.promotions, and the certificate is the authority — it is
    // already issued and cannot be renamed. A .pkpass whose passTypeIdentifier
    // differs from its signing certificate by one letter is rejected with an
    // error that does not name the field.
    appleType: 'pass.com.vesopa.promotions',
    appleStyle: 'coupon',
    appleCertFile: 'promotion_pass.cer',
    classResource: 'offerClass',
    objectResource: 'offerObject',
    payloadKey: 'offerObjects',
  },
};

/** The Google resources behind each kind. Derived, so it cannot disagree. */
const KINDS = Object.fromEntries(
  Object.entries(PASS_TYPES).map(([kind, t]) => [
    kind,
    { classResource: t.classResource, objectResource: t.objectResource },
  ])
);

/** The key each kind takes in a save JWT's payload. Also derived. */
const PAYLOAD_KEYS = Object.fromEntries(
  Object.entries(PASS_TYPES).map(([kind, t]) => [kind, t.payloadKey])
);

class WalletError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WalletError';
    this.status = status || 502;
  }
}

/**
 * Google accepts `[a-zA-Z0-9._-]` and nothing else in the half of an id that
 * follows the issuer number. An office is identified by its contact email, so
 * the `@` and the dots have to go somewhere: lower-cased, every disallowed run
 * collapsed to a single dash.
 *
 * Truncating is safe but collisions are not, so the tail carries a short hash
 * of the full input. Two offices at the same domain with long local parts would
 * otherwise flatten onto one class and share a loyalty programme.
 */
function idSuffix(...parts) {
  const raw = parts
    .map((p) => String(p == null ? '' : p))
    .join('-')
    .toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length <= 80) return cleaned || 'x';

  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return `${cleaned.slice(0, 72)}-${hash.toString(36)}`;
}

/**
 * Reads the Google credentials out of the environment.
 *
 * Both shapes are accepted because both are what people actually have:
 * GOOGLE_WALLET_SA_FILE pointing at the JSON key Google hands you, or the
 * email and key pasted in as two variables (which is what a pm2 ecosystem file
 * or a container secret usually carries). The file wins if both are set.
 *
 * Never throws on a missing configuration. An office with no wallet
 * credentials must still be able to load the back office and sell — the routes
 * check `configured` and answer 503 with a readable reason instead.
 */
function readConfig(env = process.env) {
  const problems = [];
  let email = String(env.GOOGLE_WALLET_SA_EMAIL || '').trim();
  let key = String(env.GOOGLE_WALLET_SA_KEY || '');

  const file = String(env.GOOGLE_WALLET_SA_FILE || '').trim();
  if (file) {
    try {
      // Required lazily: a deployment that configures the key inline should not
      // need the file to exist, and requiring fs at module scope in a file this
      // otherwise pure invites someone to reach for it.
      const parsed = JSON.parse(require('fs').readFileSync(file, 'utf8'));
      email = String(parsed.client_email || email).trim();
      key = String(parsed.private_key || key);
    } catch (e) {
      problems.push(`GOOGLE_WALLET_SA_FILE could not be read: ${e.message}`);
    }
  }

  // A key pasted into an env var arrives with literal backslash-n rather than
  // newlines, and a PEM with no line breaks fails to parse with an error that
  // says nothing useful about why.
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  key = key.trim();

  const issuerId = String(env.GOOGLE_WALLET_ISSUER_ID || '').trim();
  const origins = String(env.GOOGLE_WALLET_ORIGINS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!issuerId) problems.push('GOOGLE_WALLET_ISSUER_ID is not set');
  else if (!/^\d{10,25}$/.test(issuerId)) {
    problems.push(`GOOGLE_WALLET_ISSUER_ID "${issuerId}" is not an issuer number`);
  }
  if (!email) problems.push('No service-account email (GOOGLE_WALLET_SA_EMAIL or _SA_FILE)');
  else if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(email)) {
    problems.push(`"${email}" is not a service-account address`);
  }
  if (!key) problems.push('No signing key (GOOGLE_WALLET_SA_KEY or _SA_FILE)');
  else if (!key.includes('BEGIN') || !key.includes('PRIVATE KEY')) {
    problems.push('The signing key is not a PEM private key');
  }
  if (!origins.length) {
    problems.push('GOOGLE_WALLET_ORIGINS is not set (the sites the save button appears on)');
  }

  // What a newly created class claims about itself. DRAFT means "not submitted"
  // and its passes are savable only by the accounts on the issuer's test list;
  // UNDER_REVIEW is the class asking Google for publishing access, and is the
  // right default because it is the state a class has to reach before anyone
  // outside the test list can be given a card. APPROVED is Google's to set and
  // claiming it here achieves nothing.
  const reviewStatus =
    String(env.GOOGLE_WALLET_REVIEW_STATUS || '').trim().toUpperCase() ||
    'UNDER_REVIEW';

  return {
    issuerId,
    email,
    key,
    origins,
    reviewStatus,
    configured: problems.length === 0,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Templates. One builder per kind, each returning the class and the object.
// ---------------------------------------------------------------------------

/** Only send an image field if there is actually a URL; Google rejects empty. */
function image(url, description) {
  if (!url) return undefined;
  return {
    sourceUri: { uri: String(url) },
    contentDescription: {
      defaultValue: { language: 'en-GB', value: description || 'Logo' },
    },
  };
}

function text(value) {
  return { defaultValue: { language: 'en-GB', value: String(value) } };
}

/** A row of "label / value" on the face of the card. Blanks are dropped. */
function textModules(pairs) {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([header, body], i) => ({ id: `m${i}`, header: String(header), body: String(body) }));
}

/**
 * The barcode.
 *
 * QR by default because that is what a phone camera and a 2D scanner both
 * read, and because a loyalty number long enough to be unguessable does not fit
 * a readable CODE_128. `alternateText` matters more than it looks: it is what
 * the customer reads out when the scanner will not focus.
 */
function barcode(value, alternateText) {
  if (!value) return undefined;
  return {
    type: 'QR_CODE',
    value: String(value),
    alternateText: String(alternateText || value),
  };
}

/**
 * Builds the class and object for one pass.
 *
 * `brand` is the office's row from epos_wallet_settings; `subject` is the
 * person or promotion the card is for. Returns `{ classId, objectId, klass,
 * object }` — `klass` rather than `class`, which is a reserved word.
 */
function buildPass({ kind, config, office, brand = {}, subject = {} }) {
  if (!KINDS[kind]) throw new WalletError(`Unknown pass kind "${kind}"`, 400);
  const { issuerId, reviewStatus } = config;

  const classId = `${issuerId}.${idSuffix(office, kind)}`;
  const objectId = `${issuerId}.${idSuffix(office, kind, subject.id)}`;

  const issuerName = brand.issuer_name || brand.program_name || 'Vesopa';
  const programName = brand.program_name || issuerName;
  const logo = image(brand.logo_url, `${issuerName} logo`);
  const hero = image(brand.hero_url, `${issuerName}`);
  const hexBackgroundColor = brand.hex_background || undefined;

  // Google requires terms on a loyalty or offer class and shows them under
  // "Details". A programme with no terms written is worse than a bland default.
  const terms =
    brand.terms ||
    `Issued by ${issuerName}. This card is not a payment card and has no cash value. ` +
      `Points and offers are subject to the terms displayed in store.`;

  const links = [];
  if (brand.homepage_url) {
    links.push({ uri: brand.homepage_url, description: 'Website', id: 'site' });
  }
  if (brand.support_phone) {
    links.push({ uri: `tel:${brand.support_phone}`, description: 'Call us', id: 'phone' });
  }
  const linksModuleData = links.length ? { uris: links } : undefined;

  if (kind === 'loyalty') {
    return {
      classId,
      objectId,
      klass: {
        id: classId,
        issuerName,
        programName,
        programLogo: logo,
        heroImage: hero,
        hexBackgroundColor,
        reviewStatus,
        countryCode: 'GB',
        multipleDevicesAndHoldersAllowedStatus: 'MULTIPLE_HOLDERS',
        linksModuleData,
        textModulesData: textModules([['Terms', terms]]),
      },
      object: {
        id: objectId,
        classId,
        state: subject.state || 'ACTIVE',
        accountId: String(subject.card_number || subject.id || ''),
        accountName: String(subject.name || ''),
        barcode: barcode(subject.card_number || subject.id, subject.card_number),
        // The two numbers on the face of a loyalty card. `loyaltyPoints` is the
        // headline; `secondaryLoyaltyPoints` is the tier, which Google has no
        // field for and which is far too useful to leave off the card.
        loyaltyPoints: {
          label: 'Points',
          balance: { int: Number(subject.points || 0) },
        },
        secondaryLoyaltyPoints: subject.tier
          ? { label: 'Tier', balance: { string: String(subject.tier) } }
          : undefined,
        textModulesData: textModules([
          // The membership number, not the card number. They are two halves of
          // the same thing — 999800001 is what the scanner reads, 1 is what the
          // member reads out on the phone — and only one of them is worth
          // printing in words.
          ['Member no', subject.member_no],
          ['Member since', subject.member_since],
          ['Phone', subject.phone],
        ]),
        linksModuleData,
      },
    };
  }

  if (kind === 'giftcard') {
    // Google's gift card object carries the balance itself, in a currency
    // object rather than as text, which is what makes the phone show "£25.00"
    // in the right place and update it when the till spends some of it.
    const money = (minor, currency) => ({
      micros: Math.round(Number(minor || 0) * 10000),
      currencyCode: currency || 'GBP',
    });
    return {
      classId,
      objectId,
      klass: {
        id: classId,
        issuerName,
        reviewStatus,
        countryCode: 'GB',
        programLogo: logo,
        heroImage: hero,
        hexBackgroundColor,
        // The card's own title, not the loyalty programme's: a venue running a
        // rewards scheme and selling gift cards is running two things.
        merchantName: issuerName,
        localizedMerchantName: text(issuerName),
        // Google shows these two under the balance, and a gift card with no
        // stated terms is the one people ring up about.
        allowMultipleUsersPerObject: false,
        linksModuleData,
        textModulesData: textModules([['Terms', terms]]),
      },
      object: {
        id: objectId,
        classId,
        state: subject.state || 'ACTIVE',
        cardNumber: String(subject.card_number || subject.id || ''),
        balance: money(subject.balance_minor, subject.currency),
        // Google will not accept a balance without the moment it was true.
        // Without it the phone shows a figure with no date and no way for the
        // holder to tell whether it is this morning's or last Christmas's.
        balanceUpdateTime: subject.balance_at || new Date().toISOString(),
        barcode: barcode(subject.card_number || subject.id, subject.card_number),
        validTimeInterval: subject.expires_on
          ? { end: { date: `${subject.expires_on}T23:59:59.000Z` } }
          : undefined,
        textModulesData: textModules([
          ['Issued', subject.issued_on],
          ['Expires', subject.expires_on],
          ['For', subject.name],
        ]),
        linksModuleData,
      },
    };
  }

  if (kind === 'promo') {
    return {
      classId,
      objectId,
      klass: {
        id: classId,
        issuerName,
        provider: issuerName,
        title: subject.title || programName,
        // The offer is redeemed by showing the phone at the counter, not by
        // typing a code into a website.
        redemptionChannel: 'INSTORE',
        reviewStatus,
        countryCode: 'GB',
        programLogo: logo,
        heroImage: hero,
        hexBackgroundColor,
        details: subject.details || terms,
        finePrint: terms,
        linksModuleData,
      },
      object: {
        id: objectId,
        classId,
        state: subject.state || 'ACTIVE',
        barcode: barcode(subject.card_number || subject.id, subject.card_number),
        // An offer with no end date stays in the wallet for ever and is a
        // support call waiting to happen, so the promotion's own end date is
        // carried through when it has one.
        validTimeInterval: subject.ends_on
          ? { end: { date: `${subject.ends_on}T23:59:59.000Z` } }
          : undefined,
        textModulesData: textModules([
          ['Offer', subject.details],
          ['Valid until', subject.ends_on],
        ]),
        linksModuleData,
      },
    };
  }

  // customer and staff are both generic passes. A generic class is nearly
  // empty by design — everything visible lives on the object, which is why
  // these two share a class and still look completely different.
  const isStaff = kind === 'staff';
  return {
    classId,
    objectId,
    klass: {
      id: classId,
      issuerName,
      reviewStatus,
      linksModuleData,
    },
    object: {
      id: objectId,
      classId,
      state: subject.state || 'ACTIVE',
      // cardTitle, header, logo and hexBackgroundColor are the four fields a
      // generic object cannot be created without.
      cardTitle: text(issuerName),
      header: text(subject.name || (isStaff ? 'Staff' : 'Member')),
      subheader: text(isStaff ? subject.role || 'Staff' : programName),
      logo,
      heroImage: hero,
      hexBackgroundColor: hexBackgroundColor || (isStaff ? '#1f2937' : '#0f5132'),
      barcode: barcode(subject.card_number || subject.id, subject.card_number),
      textModulesData: isStaff
        ? textModules([
            ['Staff', subject.name],
            ['Role', subject.role],
            ['Card', subject.card_number],
          ])
        : textModules([
            ['Member', subject.name],
            ['Member no', subject.member_no],
            ['Card', subject.card_number],
            ['Discount', subject.discount],
            ['Phone', subject.phone],
          ]),
      linksModuleData,
    },
  };
}

/**
 * Strips `undefined` recursively.
 *
 * JSON.stringify already drops undefined properties, but the Wallet REST API
 * is also sent objects that survived a round trip through code that checks
 * `'field' in object`, and an explicitly-undefined key there reads as present.
 * Cheaper to normalise once than to reason about it at each call site.
 */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const pruned = prune(v);
      if (pruned !== undefined) out[k] = pruned;
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The signed save link.
// ---------------------------------------------------------------------------

/**
 * Signs an "Add to Google Wallet" link.
 *
 * `payload` is either `{ ids: [...] }` — the short form, for objects that
 * already exist at Google — or `{ klass, object, kind }` for the inline form.
 *
 * Returns `{ url, length, tooLong }`. `tooLong` is reported rather than thrown
 * because a link over the safe length usually still works; it is the caller's
 * job to prefer the short form when it can, and the back office shows the
 * warning so the length problem is visible before a customer meets it.
 */
function saveUrl({ config, kind, ids, klass, object }) {
  if (!config.configured) {
    throw new WalletError(`Google Wallet is not configured: ${config.problems.join('; ')}`, 503);
  }
  const key = PAYLOAD_KEYS[kind];
  if (!key) throw new WalletError(`Unknown pass kind "${kind}"`, 400);

  const payload = {};
  if (ids && ids.length) {
    payload[key] = ids.map((id) => ({ id: String(id) }));
  } else if (object) {
    payload[key] = [prune(object)];
    if (klass) {
      payload[`${key.replace(/Objects$/, 'Classes')}`] = [prune(klass)];
    }
  } else {
    throw new WalletError('A save link needs either object ids or an object', 400);
  }

  const token = jwt.sign(
    {
      iss: config.email,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      origins: config.origins,
      payload,
    },
    config.key,
    { algorithm: 'RS256' }
  );

  const url = `${SAVE_PREFIX}${token}`;
  return { url, token, length: url.length, tooLong: token.length > SAFE_JWT_LENGTH };
}

// ---------------------------------------------------------------------------
// The REST client.
// ---------------------------------------------------------------------------

/**
 * Exchanges the service-account key for an access token.
 *
 * Cached until a minute before it expires. The exchange is the first thing that
 * fails when the key is wrong, and its error body is the single most useful
 * diagnostic in the whole integration, so it is passed through verbatim rather
 * than flattened to "authentication failed".
 */
function makeTokenSource(config, fetchImpl = fetch) {
  let cached = null;

  return async function accessToken() {
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;

    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      { iss: config.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
      config.key,
      { algorithm: 'RS256' }
    );

    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });

    const body = await res.text();
    if (!res.ok) {
      throw new WalletError(`Google refused the service-account key: ${body}`, 502);
    }
    const parsed = JSON.parse(body);
    cached = {
      token: parsed.access_token,
      expires: Date.now() + Number(parsed.expires_in || 3600) * 1000,
    };
    return cached.token;
  };
}

/**
 * A REST client for walletobjects.
 *
 * `fetchImpl` is injectable so the whole of this can be driven in a test
 * without an issuer account; nothing else in here knows the difference.
 */
function makeClient(config, fetchImpl = fetch) {
  const accessToken = makeTokenSource(config, fetchImpl);

  async function call(method, path, body) {
    const token = await accessToken();
    const res = await fetchImpl(`${WALLET_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(prune(body)),
    });

    const raw = await res.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const message =
        (parsed && parsed.error && parsed.error.message) || raw || res.statusText;
      const err = new WalletError(message, res.status);
      err.googleStatus = res.status;
      throw err;
    }
    return parsed;
  }

  return {
    /**
     * Creates the class if it is missing, updates it if it is not.
     *
     * A blind POST answers 409 on the second deploy and a blind PUT answers 404
     * on the first, so both are tried. PUT rather than PATCH: the class is
     * generated whole from the office's settings every time, and a PATCH would
     * leave a field that had been cleared in the back office still set at
     * Google.
     */
    async upsertClass(kind, klass) {
      const { classResource } = KINDS[kind];
      try {
        return await call('PUT', `/${classResource}/${encodeURIComponent(klass.id)}`, klass);
      } catch (e) {
        if (e.googleStatus !== 404) throw e;
        return call('POST', `/${classResource}`, klass);
      }
    },

    /**
     * Same shape for objects, with one difference that matters: an existing
     * object is PATCHed, not replaced. The object holds the customer's points,
     * and a PUT built from a stale read would set the balance back.
     */
    async upsertObject(kind, object) {
      const { objectResource } = KINDS[kind];
      try {
        return await call('PATCH', `/${objectResource}/${encodeURIComponent(object.id)}`, object);
      } catch (e) {
        if (e.googleStatus !== 404) throw e;
        return call('POST', `/${objectResource}`, object);
      }
    },

    async getClass(kind, classId) {
      const { classResource } = KINDS[kind];
      return call('GET', `/${classResource}/${encodeURIComponent(classId)}`);
    },

    async getObject(kind, objectId) {
      const { objectResource } = KINDS[kind];
      return call('GET', `/${objectResource}/${encodeURIComponent(objectId)}`);
    },

    /** Used by the diagnostic route to prove the credentials actually work. */
    async listClasses(kind, issuerId) {
      const { classResource } = KINDS[kind];
      return call('GET', `/${classResource}?issuerId=${encodeURIComponent(issuerId)}`);
    },

    accessToken,
  };
}

module.exports = {
  PASS_TYPES,
  KINDS,
  PAYLOAD_KEYS,
  SAFE_JWT_LENGTH,
  SAVE_PREFIX,
  WALLET_API,
  WalletError,
  buildPass,
  idSuffix,
  makeClient,
  makeTokenSource,
  prune,
  readConfig,
  saveUrl,
};
