/**
 * Countries, for every form that asks for one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Both places that collect an address asked for the country as a two-character
 * text box with `maxlength="2"`. That is a field only somebody who already
 * knows the ISO code can fill in. Everyone else types "UK" (which is not the
 * code — GB is), or "England", or gives up. And the value is not cosmetic: it
 * goes to the registrar as the registrant's country of record on a real domain
 * registration, where a wrong code is a compliance problem rather than a typo,
 * and it decides which currency the catalogue is priced in.
 *
 * A picker cannot be got wrong, so it is a picker.
 *
 * ---------------------------------------------------------------------------
 * THE LIST
 * ---------------------------------------------------------------------------
 * ISO 3166-1 alpha-2, with the names people actually search for rather than the
 * formal ones — "South Korea", not "Korea, Republic of". A customer scanning a
 * list under K for their own country and not finding it is the failure this is
 * avoiding, and the formal names are the reason it happens.
 *
 * The handful at the top are the markets this business actually sells into.
 * Alphabetical-only means a UK hosting company's UK customers scroll past 180
 * countries to reach their own, every single time.
 */

/** Shown first, in this order, then a separator, then everything alphabetically. */
const PRIORITY = ['GB', 'IE', 'US', 'CA', 'AU', 'NZ', 'DE', 'FR', 'ES', 'IT', 'NL', 'IN'];

const NAMES = {
  AD: 'Andorra', AE: 'United Arab Emirates', AF: 'Afghanistan', AG: 'Antigua and Barbuda',
  AI: 'Anguilla', AL: 'Albania', AM: 'Armenia', AO: 'Angola', AR: 'Argentina',
  AS: 'American Samoa', AT: 'Austria', AU: 'Australia', AW: 'Aruba', AX: 'Åland Islands',
  AZ: 'Azerbaijan', BA: 'Bosnia and Herzegovina', BB: 'Barbados', BD: 'Bangladesh',
  BE: 'Belgium', BF: 'Burkina Faso', BG: 'Bulgaria', BH: 'Bahrain', BI: 'Burundi',
  BJ: 'Benin', BL: 'Saint Barthélemy', BM: 'Bermuda', BN: 'Brunei', BO: 'Bolivia',
  BQ: 'Caribbean Netherlands', BR: 'Brazil', BS: 'Bahamas', BT: 'Bhutan', BW: 'Botswana',
  BY: 'Belarus', BZ: 'Belize', CA: 'Canada', CD: 'DR Congo', CF: 'Central African Republic',
  CG: 'Congo', CH: 'Switzerland', CI: 'Côte d’Ivoire', CK: 'Cook Islands', CL: 'Chile',
  CM: 'Cameroon', CN: 'China', CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba',
  CV: 'Cape Verde', CW: 'Curaçao', CY: 'Cyprus', CZ: 'Czechia', DE: 'Germany',
  DJ: 'Djibouti', DK: 'Denmark', DM: 'Dominica', DO: 'Dominican Republic', DZ: 'Algeria',
  EC: 'Ecuador', EE: 'Estonia', EG: 'Egypt', ER: 'Eritrea', ES: 'Spain', ET: 'Ethiopia',
  FI: 'Finland', FJ: 'Fiji', FK: 'Falkland Islands', FM: 'Micronesia', FO: 'Faroe Islands',
  FR: 'France', GA: 'Gabon', GB: 'United Kingdom', GD: 'Grenada', GE: 'Georgia',
  GG: 'Guernsey', GH: 'Ghana', GI: 'Gibraltar', GL: 'Greenland', GM: 'Gambia',
  GN: 'Guinea', GQ: 'Equatorial Guinea', GR: 'Greece', GT: 'Guatemala', GU: 'Guam',
  GW: 'Guinea-Bissau', GY: 'Guyana', HK: 'Hong Kong', HN: 'Honduras', HR: 'Croatia',
  HT: 'Haiti', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel',
  IM: 'Isle of Man', IN: 'India', IQ: 'Iraq', IR: 'Iran', IS: 'Iceland', IT: 'Italy',
  JE: 'Jersey', JM: 'Jamaica', JO: 'Jordan', JP: 'Japan', KE: 'Kenya', KG: 'Kyrgyzstan',
  KH: 'Cambodia', KI: 'Kiribati', KM: 'Comoros', KN: 'Saint Kitts and Nevis',
  KP: 'North Korea', KR: 'South Korea', KW: 'Kuwait', KY: 'Cayman Islands',
  KZ: 'Kazakhstan', LA: 'Laos', LB: 'Lebanon', LC: 'Saint Lucia', LI: 'Liechtenstein',
  LK: 'Sri Lanka', LR: 'Liberia', LS: 'Lesotho', LT: 'Lithuania', LU: 'Luxembourg',
  LV: 'Latvia', LY: 'Libya', MA: 'Morocco', MC: 'Monaco', MD: 'Moldova', ME: 'Montenegro',
  MF: 'Saint Martin', MG: 'Madagascar', MH: 'Marshall Islands', MK: 'North Macedonia',
  ML: 'Mali', MM: 'Myanmar', MN: 'Mongolia', MO: 'Macao', MP: 'Northern Mariana Islands',
  MQ: 'Martinique', MR: 'Mauritania', MS: 'Montserrat', MT: 'Malta', MU: 'Mauritius',
  MV: 'Maldives', MW: 'Malawi', MX: 'Mexico', MY: 'Malaysia', MZ: 'Mozambique',
  NA: 'Namibia', NC: 'New Caledonia', NE: 'Niger', NF: 'Norfolk Island', NG: 'Nigeria',
  NI: 'Nicaragua', NL: 'Netherlands', NO: 'Norway', NP: 'Nepal', NR: 'Nauru', NU: 'Niue',
  NZ: 'New Zealand', OM: 'Oman', PA: 'Panama', PE: 'Peru', PF: 'French Polynesia',
  PG: 'Papua New Guinea', PH: 'Philippines', PK: 'Pakistan', PL: 'Poland',
  PM: 'Saint Pierre and Miquelon', PR: 'Puerto Rico', PS: 'Palestine', PT: 'Portugal',
  PW: 'Palau', PY: 'Paraguay', QA: 'Qatar', RE: 'Réunion', RO: 'Romania', RS: 'Serbia',
  RU: 'Russia', RW: 'Rwanda', SA: 'Saudi Arabia', SB: 'Solomon Islands', SC: 'Seychelles',
  SD: 'Sudan', SE: 'Sweden', SG: 'Singapore', SI: 'Slovenia', SK: 'Slovakia',
  SL: 'Sierra Leone', SM: 'San Marino', SN: 'Senegal', SO: 'Somalia', SR: 'Suriname',
  SS: 'South Sudan', ST: 'São Tomé and Príncipe', SV: 'El Salvador', SX: 'Sint Maarten',
  SY: 'Syria', SZ: 'Eswatini', TC: 'Turks and Caicos Islands', TD: 'Chad', TG: 'Togo',
  TH: 'Thailand', TJ: 'Tajikistan', TK: 'Tokelau', TL: 'Timor-Leste', TM: 'Turkmenistan',
  TN: 'Tunisia', TO: 'Tonga', TR: 'Türkiye', TT: 'Trinidad and Tobago', TV: 'Tuvalu',
  TW: 'Taiwan', TZ: 'Tanzania', UA: 'Ukraine', UG: 'Uganda', US: 'United States',
  UY: 'Uruguay', UZ: 'Uzbekistan', VA: 'Vatican City', VC: 'Saint Vincent and the Grenadines',
  VE: 'Venezuela', VG: 'British Virgin Islands', VI: 'U.S. Virgin Islands', VN: 'Vietnam',
  VU: 'Vanuatu', WF: 'Wallis and Futuna', WS: 'Samoa', YE: 'Yemen', YT: 'Mayotte',
  ZA: 'South Africa', ZM: 'Zambia', ZW: 'Zimbabwe',
};

/**
 * E.164 country calling codes, keyed by the same ISO codes as NAMES.
 *
 * WHY THIS IS HERE AND NOT INFERRED FROM THE NUMBER
 * ------------------------------------------------
 * The registrar wants the calling code and the subscriber number in two
 * separate fields, and it wants the calling code as bare digits. The adapter
 * used to derive it by taking `phone.slice(1, 3)` — the first two digits after
 * a "+" — and defaulting to '44' when there was no "+" at all.
 *
 * Both halves of that are wrong. Two digits truncates every three-digit code:
 * a Bangladeshi +880 number was filed as country code 88 (which is nobody) with
 * the leading 0 of the real code eaten into the subscriber number. And the '44'
 * default stamped "United Kingdom" onto the phone number of every customer who
 * typed their number without a "+", regardless of the country they had just
 * picked from the address form two fields above.
 *
 * The country is a required field on the same form. Deriving the calling code
 * from THAT is right by construction, so an explicit "+" prefix is now only a
 * fallback for the case where the two disagree.
 */
const DIAL = {
  AD: '376', AE: '971', AF: '93', AG: '1', AI: '1', AL: '355', AM: '374', AO: '244',
  AR: '54', AS: '1', AT: '43', AU: '61', AW: '297', AX: '358', AZ: '994', BA: '387',
  BB: '1', BD: '880', BE: '32', BF: '226', BG: '359', BH: '973', BI: '257', BJ: '229',
  BL: '590', BM: '1', BN: '673', BO: '591', BQ: '599', BR: '55', BS: '1', BT: '975',
  BW: '267', BY: '375', BZ: '501', CA: '1', CD: '243', CF: '236', CG: '242', CH: '41',
  CI: '225', CK: '682', CL: '56', CM: '237', CN: '86', CO: '57', CR: '506', CU: '53',
  CV: '238', CW: '599', CY: '357', CZ: '420', DE: '49', DJ: '253', DK: '45', DM: '1',
  DO: '1', DZ: '213', EC: '593', EE: '372', EG: '20', ER: '291', ES: '34', ET: '251',
  FI: '358', FJ: '679', FK: '500', FM: '691', FO: '298', FR: '33', GA: '241', GB: '44',
  GD: '1', GE: '995', GG: '44', GH: '233', GI: '350', GL: '299', GM: '220', GN: '224',
  GQ: '240', GR: '30', GT: '502', GU: '1', GW: '245', GY: '592', HK: '852', HN: '504',
  HR: '385', HT: '509', HU: '36', ID: '62', IE: '353', IL: '972', IM: '44', IN: '91',
  IQ: '964', IR: '98', IS: '354', IT: '39', JE: '44', JM: '1', JO: '962', JP: '81',
  KE: '254', KG: '996', KH: '855', KI: '686', KM: '269', KN: '1', KP: '850', KR: '82',
  KW: '965', KY: '1', KZ: '7', LA: '856', LB: '961', LC: '1', LI: '423', LK: '94',
  LR: '231', LS: '266', LT: '370', LU: '352', LV: '371', LY: '218', MA: '212', MC: '377',
  MD: '373', ME: '382', MF: '590', MG: '261', MH: '692', MK: '389', ML: '223', MM: '95',
  MN: '976', MO: '853', MP: '1', MQ: '596', MR: '222', MS: '1', MT: '356', MU: '230',
  MV: '960', MW: '265', MX: '52', MY: '60', MZ: '258', NA: '264', NC: '687', NE: '227',
  NF: '672', NG: '234', NI: '505', NL: '31', NO: '47', NP: '977', NR: '674', NU: '683',
  NZ: '64', OM: '968', PA: '507', PE: '51', PF: '689', PG: '675', PH: '63', PK: '92',
  PL: '48', PM: '508', PR: '1', PS: '970', PT: '351', PW: '680', PY: '595', QA: '974',
  RE: '262', RO: '40', RS: '381', RU: '7', RW: '250', SA: '966', SB: '677', SC: '248',
  SD: '249', SE: '46', SG: '65', SI: '386', SK: '421', SL: '232', SM: '378', SN: '221',
  SO: '252', SR: '597', SS: '211', ST: '239', SV: '503', SX: '1', SY: '963', SZ: '268',
  TC: '1', TD: '235', TG: '228', TH: '66', TJ: '992', TK: '690', TL: '670', TM: '993',
  TN: '216', TO: '676', TR: '90', TT: '1', TV: '688', TW: '886', TZ: '255', UA: '380',
  UG: '256', US: '1', UY: '598', UZ: '998', VA: '39', VC: '1', VE: '58', VG: '1',
  VI: '1', VN: '84', VU: '678', WF: '681', WS: '685', YE: '967', YT: '262', ZA: '27',
  ZM: '260', ZW: '263',
};

/** The bare-digit calling code for a country, or '' if we do not know it. */
function dialCode(code) {
  return DIAL[String(code || '').toUpperCase()] || '';
}

/** `true` if `code` is a country we will accept on a form. */
function isValid(code) {
  return Object.prototype.hasOwnProperty.call(NAMES, String(code || '').toUpperCase());
}

function nameOf(code) {
  return NAMES[String(code || '').toUpperCase()] || '';
}

/**
 * The list a `<select>` renders, priority group first.
 *
 * @returns {Array<{code: string, name: string, group: 'common'|'all'}>}
 */
function options() {
  const rest = Object.keys(NAMES)
    .filter((c) => !PRIORITY.includes(c))
    .sort((a, b) => NAMES[a].localeCompare(NAMES[b], 'en'));
  return [
    ...PRIORITY.filter((c) => NAMES[c]).map((code) => ({ code, name: NAMES[code], group: 'common' })),
    ...rest.map((code) => ({ code, name: NAMES[code], group: 'all' })),
  ];
}

/**
 * What to pre-select when nothing is stored yet.
 *
 * Order: what the customer already has, then what their address geolocates to,
 * then GB. `geo` is whatever src/geo.js worked out from the request — it is a
 * SUGGESTION on a form the customer can change, never a value written to an
 * account without them seeing it, because a VPN or a mobile carrier's routing
 * would otherwise silently file somebody's domain registration under the wrong
 * country.
 */
function pick(stored, geo) {
  if (isValid(stored)) return String(stored).toUpperCase();
  if (isValid(geo)) return String(geo).toUpperCase();
  return 'GB';
}

module.exports = { NAMES, PRIORITY, DIAL, dialCode, isValid, nameOf, options, pick };
