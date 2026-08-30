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

module.exports = { NAMES, PRIORITY, isValid, nameOf, options, pick };
