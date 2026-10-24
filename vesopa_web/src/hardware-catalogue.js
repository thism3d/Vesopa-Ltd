'use strict';

/**
 * The hardware Vesopa sells: the home page teaser, /hardware, each product's
 * own page (/hardware/<slug>) and the hardware checkout.
 *
 * Supplier: OCOM Technologies (ocominc.com). Specs are the supplier's own,
 * from their product pages (docs/hardware/ocom-products.json, collected
 * 2026-10-24); the gallery photos are the supplier's, downloaded to
 * public/assets/v2/hw/. The first photo of each product is the brochure's,
 * with the Vesopa wordmark on the bezel.
 *
 * Prices are Vesopa's retail prices, ex VAT; supplier cost prices are never
 * here. `stock: 'in'` = already in the UK (POS-1566 tills, OCPP-80A printers),
 * delivered free; anything else ships from the supplier, and the customer then
 * picks one of DELIVERY (the owner, 2026-10-24: "$300 equivalent for DHL for 3
 * days delivery or $120 equivalent for 15 day delivery").
 *
 * The barcode scanner is the supplier's OCBS-T218 2D omni-directional scanner
 * (OCBS-T2182D on Meirion's order list).
 */
const IMG = '/assets/v2/';
const HW = '/assets/v2/hw/';
const gallery = (sku, n) => Array.from({ length: n }, (_, i) => `${HW}${sku.toLowerCase()}-${i + 1}.webp`);
const WARRANTY = ['Warranty', '12 months, supported by Vesopa'];

const PRODUCTS = [
  {
    sku: 'POS-1566', slug: 'vesopa-till-15-pro', cat: 'till', name: 'Vesopa Till 15.6" Pro', runs: 'Vesopa EPOS', price: 599, stock: 'in',
    img: IMG + 'till-1566.jpg', gallery: gallery('POS-1566', 5), short: 'Intel i5, 8GB, 128GB SSD',
    headline: 'Splash-resistant till with a tilting screen and room for a customer display.',
    highlights: ['Borderless splash-proof front, wipes clean behind a busy bar', 'Intel Core i5 with 8GB and an SSD: Vesopa EPOS opens in seconds', 'Tilting screen, aluminium base and hidden cable channels', 'Add an 11.6" customer display or a 2x20 pole display'],
    inBox: ['Till with stand', 'UK power adapter', 'Vesopa EPOS installed and signed in'],
    goes: ['OCPP-80A', 'OCBS-T2182D', 'KDS-181'],
    specs: [
      ['Screen', '15.6" BOE 1366x768 (1920x1080 optional), 250 cd/m2, projected capacitive (G+G)'],
      ['Customer display', '11.6" 1366x768 second screen or 2x20 VFD (optional)'],
      ['Processor', 'Intel Core i5'],
      ['Memory', '8GB DDR3L (up to 16GB)'],
      ['Storage', '128GB SSD (up to 512GB)'],
      ['System', 'Windows 10/11'],
      ['Network', 'Gigabit LAN; Wi-Fi 2.4/5GHz and Bluetooth 5.0 optional'],
      ['Ports', 'USB 3.0 x2, USB 2.0 x4, COM, HDMI, RJ-45, audio'],
      ['Body', 'Borderless splash-proof front, aluminium base, cable channels'],
      ['Weight', '3.5 kg'],
      ['Power', '100-240V in, 12V/5A adapter (UK plug)'],
      ['Operating temperature', '0-40 C'],
      WARRANTY,
    ],
  },
  {
    sku: 'POS-1562', slug: 'vesopa-till-15-super-slim', cat: 'till', name: 'Vesopa Till 15.6" Super-Slim', runs: 'Vesopa EPOS', price: 599, stock: 'lead',
    img: IMG + 'till-1562.jpg', gallery: gallery('POS-1562', 8), short: 'Die-cast aluminium, Celeron J6412',
    headline: 'Die-cast aluminium and super slim, and it keeps trading when the broadband drops.',
    highlights: ['Die-cast aluminium housing and base', 'Two serial ports for older printers and cash drawers', 'Optional 11.6" customer display on the back', 'Vesopa EPOS keeps trading offline and syncs when the line is back'],
    inBox: ['Till with stand', 'UK power adapter', 'Vesopa EPOS installed and signed in'],
    goes: ['OCPP-80A', 'OCBS-T2182D', 'KDS-151'],
    specs: [
      ['Screen', '15.6" 1366x768, 220 cd/m2, multi-point projected capacitive (G+G)'],
      ['Customer display', '11.6" second screen (touch optional)'],
      ['Processor', 'Intel Celeron J6412 2.0GHz (Core i3 optional)'],
      ['Memory', '4GB DDR4 (8/16GB optional)'],
      ['Storage', '64GB M.2 SSD (up to 512GB)'],
      ['System', 'Windows 10/11'],
      ['Network', 'Gigabit LAN, Wi-Fi module'],
      ['Ports', 'USB x6, COM x2, HDMI, RJ-45, audio'],
      ['Body', 'Aluminium alloy housing and base'],
      ['Weight', '3.6 kg'],
      ['Power', '100-240V in, 12V/5A adapter (UK plug)'],
      ['Operating temperature', '0-50 C'],
      WARRANTY,
    ],
  },
  {
    sku: 'KDS-181', slug: 'vesopa-kitchen-screen-18', cat: 'kitchen', name: 'Vesopa Kitchen Screen 18.5"', runs: 'Vesopa Kitchen', price: 449, stock: 'lead',
    img: IMG + 'kds-181.jpg', gallery: gallery('KDS-181', 8), short: 'Celeron J4125, 128GB SSD',
    headline: 'The pass without the paper: tickets from the till with the wait time and a loud new-order beep.',
    highlights: ['Tickets arrive the moment the till sends them, with the wait time', '178 degree viewing, readable from across the kitchen', '3W speaker for the new-order beep', 'Aluminium and metal body, wall or bench'],
    inBox: ['Kitchen screen', 'UK power adapter', 'Vesopa Kitchen installed and paired'],
    goes: ['OCPP-80D', 'POS-1566'],
    specs: [
      ['Screen', '18.5" 1366x768, 250 cd/m2, 178 degree viewing, projected capacitive'],
      ['Processor', 'Intel Celeron J4125 quad-core 2.0GHz'],
      ['Memory', '4GB DDR4'],
      ['Storage', '128GB SSD'],
      ['System', 'Windows 10 Pro'],
      ['Network', 'Gigabit LAN, Wi-Fi (dual band optional), Bluetooth 4.0'],
      ['Ports', 'USB x4, RJ-45'],
      ['Speaker', '8 ohm 3W, for the new-order beep'],
      ['Body', 'Aluminium and metal'],
      ['Size', '456 x 277 x 57 mm'],
      ['Weight', '4.5 kg'],
      ['Power', '100-240V in, 12V/5A adapter (UK plug)'],
      WARRANTY,
    ],
  },
  {
    sku: 'KDS-151', slug: 'vesopa-kitchen-screen-15', cat: 'kitchen', name: 'Vesopa Kitchen Screen 15"', runs: 'Vesopa Kitchen', price: 379, stock: 'lead',
    img: IMG + 'kds-151.jpg', gallery: [], short: 'Compact, pairs itself',
    headline: 'The compact screen for smaller kitchens, bars and prep stations. It finds the till and pairs itself.',
    highlights: ['Compact 15" touch screen for bars and prep stations', 'Finds the till on the network, no IP addresses to type', 'Same Vesopa Kitchen app as the 18.5" screen'],
    inBox: ['Kitchen screen', 'UK power adapter', 'Vesopa Kitchen installed and paired'],
    goes: ['OCPP-80D', 'POS-1562'],
    specs: [
      ['Screen', '15" touch'],
      ['Pairing', 'Finds the till on the network and pairs itself'],
      ['System', 'Windows (same family as the 18.5" screen)'],
      WARRANTY,
    ],
  },
  {
    sku: 'OCPP-80A', slug: 'vesopa-receipt-printer-80mm', cat: 'printer', name: 'Vesopa Receipt Printer 80mm', runs: 'Vesopa EPOS', price: 129, stock: 'in',
    img: IMG + 'printer-80a.jpg', gallery: gallery('OCPP-80A', 7), short: 'USB + LAN, auto cutter',
    headline: 'Receipts with your logo and the end-of-day reports, fast and sharp.',
    highlights: ['Up to 260 mm a second with an auto cutter', 'Your logo, barcodes and QR codes on every receipt', 'USB and network in the box', 'Drop-in 80 mm paper loading'],
    inBox: ['Printer', 'Power adapter', 'Set up with Vesopa EPOS by us'],
    goes: ['POS-1566', 'OCBS-T2182D'],
    specs: [
      ['Printing', 'Direct thermal, 203 dpi'],
      ['Speed', 'Up to 260 mm/s'],
      ['Paper', '80 mm roll (72 mm print width), up to 80 mm across'],
      ['Cutter', 'Auto cutter, 1 million cuts'],
      ['Print head life', '100 km'],
      ['Connection', 'USB and LAN (serial, Wi-Fi or Bluetooth options)'],
      ['Codes', '1D barcodes, QR codes, PDF417'],
      ['Commands', 'ESC/POS'],
      ['Size', '160 x 135 x 125 mm'],
      ['Weight', '0.8 kg'],
      ['Power', '24V/1.5A adapter'],
      WARRANTY,
    ],
  },
  {
    sku: 'OCPP-80D', slug: 'vesopa-kitchen-printer-80mm', cat: 'printer', name: 'Vesopa Kitchen Printer 80mm', runs: 'Vesopa EPOS', price: 149, stock: 'lead',
    img: IMG + 'printer-80d.jpg', gallery: gallery('OCPP-80D', 8), short: 'Flashing light + loud beeper',
    headline: 'A proper kitchen printer: flashing light and loud beeper, wall-mountable.',
    highlights: ['Flashing light and loud beeper so no ticket is missed', '300 mm a second, Japanese cutter rated for 1.5 million cuts', 'Wall bracket built in', 'Opens a cash drawer (24V)'],
    inBox: ['Printer', 'Power adapter', 'Set up with Vesopa EPOS by us'],
    goes: ['KDS-181', 'POS-1566'],
    specs: [
      ['Printing', 'Direct thermal, 203 dpi'],
      ['Speed', '300 mm/s'],
      ['Kitchen alert', 'Flashing LED and loud beeper'],
      ['Cutter', 'Japanese mechanism, 1.5 million cuts'],
      ['Print head life', '150 km'],
      ['Connection', 'Serial, USB and LAN (Wi-Fi or Bluetooth options)'],
      ['Mounting', 'Desk or wall, bracket built in'],
      ['Cash drawer', '24V kick-out port'],
      ['Size', '186 x 143 x 140 mm'],
      ['Weight', '1.0 kg'],
      ['Power', '24V/2.5A adapter'],
      WARRANTY,
    ],
  },
  {
    sku: 'OCBS-T2182D', slug: 'vesopa-barcode-scanner', cat: 'scanner', name: 'Vesopa Barcode Scanner', runs: 'Vesopa EPOS', price: 69, stock: 'lead',
    img: HW + 'ocbs-t2182d-1.webp', gallery: gallery('OCBS-T2182D', 7), short: '1D + 2D omni-directional, USB',
    headline: 'Scan products, gift cards, vouchers and phone screens straight onto the bill, hands free.',
    highlights: ['Reads 1D barcodes and 2D codes (QR, Data Matrix, PDF417)', 'Reads codes from phone screens: e-vouchers and loyalty cards', 'Hands free on the counter, 360 degree roll', 'USB, plug and play'],
    inBox: ['Scanner', 'Set up with Vesopa EPOS by us'],
    goes: ['POS-1566', 'OCPP-80A'],
    specs: [
      ['Model', 'OCBS-T218 2D omni-directional'],
      ['Sensor', 'CMOS 640x480'],
      ['Light source', 'Blue LED aimer, red LED illumination'],
      ['Field of view', '39 degrees (H) x 29 degrees (V)'],
      ['Resolution', '4 mil or finer'],
      ['Scan angle', 'Pitch and skew +/-65 degrees, roll 360 degrees'],
      ['Depth of field', 'Code39 13mil 0-170 mm; QR 20mil 0-110 mm'],
      ['Reads 1D', 'Code 128, GS1-128, EAN-8/13, UPC-A/E, Code 39, Code 93, Interleaved 2 of 5, Codabar, GS1 DataBar and more'],
      ['Reads 2D', 'QR Code, Data Matrix, PDF417, MicroPDF417, Aztec, MaxiCode, DotCode, Han Xin'],
      ['Ambient light', '0-100,000 lux'],
      ['Interface', 'USB, 5V'],
      ['Drop rating', '1.2 m'],
      ['Size and weight', '140 x 84 x 90 mm, 249 g'],
      ['Operating temperature', '0-45 C'],
      WARRANTY,
    ],
  },
  {
    sku: 'POS-K01', slug: 'vesopa-self-service-kiosk', cat: 'kiosk', name: 'Vesopa Self-Service Kiosk', runs: 'Vesopa Express', price: 1499, stock: 'lead',
    img: IMG + 'kiosk.jpg', gallery: gallery('POS-K01', 6), short: '21.5" Full HD, printer, scanner',
    headline: 'Order here, skip the queue: the menu in pictures, meal deals and card payment at the kiosk.',
    highlights: ['21.5" Full HD touch screen (27" and 32" on request)', 'Built-in receipt printer and 1D/2D scanner for vouchers', 'Bracket for your card machine, NFC option', 'Floor stand, wall or counter'],
    inBox: ['Kiosk', 'Vesopa Express installed and paired'],
    goes: ['KDS-181', 'OCPP-80D'],
    specs: [
      ['Screen', '21.5" Full HD IPS, 10-point capacitive touch (27" and 32" on request)'],
      ['Processor', 'Intel Celeron N5095 (Core i3/i5 optional)'],
      ['Memory', '8GB DDR4'],
      ['Storage', '128GB SSD'],
      ['System', 'Windows 10/11'],
      ['Printer', '80 mm thermal with auto cutter'],
      ['Scanner', '1D/2D scanning window for vouchers and QR codes'],
      ['Card payments', 'Card machine bracket, NFC option'],
      ['Mounting', 'Floor stand, wall or counter'],
      ['Speaker', 'Built in'],
      WARRANTY,
    ],
  },
];

const CATEGORIES = [
  ['all', 'All hardware'], ['till', 'Tills'], ['kitchen', 'Kitchen screens'],
  ['printer', 'Printers'], ['scanner', 'Scanners'], ['kiosk', 'Kiosks'],
];

/**
 * Delivery for anything not already in the UK, ex VAT. The owner's figures are
 * in dollars (DHL $300 for about 3 days, $120 for about 15 days); these are
 * their sterling equivalents.
 */
const DELIVERY = {
  express: { key: 'express', name: 'DHL Express, about 3 working days', minor: 23000 },
  standard: { key: 'standard', name: 'Standard, about 15 working days', minor: 9500 },
};
const VAT_RATE = 0.2;

const gbp = (n) => '£' + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 });

/** The small WebP made for cards (public/assets/v2/sm/); the full image stays for zoom. */
const small = (src) => (src ? src.replace(/\/assets\/v2\/([^/]+)\.jpg$/, '/assets/v2/sm/$1.webp') : src);

const bySku = (sku) => PRODUCTS.find((p) => p.sku === sku) || null;
const bySlug = (slug) => PRODUCTS.find((p) => p.slug === slug) || null;

/** "POS-1566:2,OCPP-80A:1" (or an object) to [{ sku, qty }], unknown SKUs dropped, 1-50 each. */
function parseCart(raw) {
  const pairs = typeof raw === 'string'
    ? raw.split(',').map((s) => s.split(':'))
    : Object.entries(raw || {});
  const out = new Map();
  for (const [sku, q] of pairs) {
    const p = bySku(String(sku || '').trim());
    const qty = Math.max(0, Math.min(50, parseInt(q, 10) || 0));
    if (p && qty) out.set(p.sku, (out.get(p.sku) || 0) + qty);
  }
  return [...out].map(([sku, qty]) => ({ sku, qty: Math.min(50, qty) }));
}

const cartString = (cart) => cart.map((l) => `${l.sku}:${l.qty}`).join(',');

/**
 * The priced order, always from the catalogue (never from the browser): lines,
 * subtotal, delivery, VAT and total, in pence. `delivery` is required (express
 * or standard) only when something is not in stock.
 */
function priceCart(cart, deliveryKey) {
  const lines = cart.map((l) => {
    const p = bySku(l.sku);
    return { sku: p.sku, name: p.name, qty: l.qty, unit_minor: p.price * 100, total_minor: p.price * 100 * l.qty, stock: p.stock };
  });
  const needsDelivery = lines.some((l) => l.stock !== 'in');
  const delivery = needsDelivery ? DELIVERY[deliveryKey] || null : null;
  const goods = lines.reduce((t, l) => t + l.total_minor, 0);
  const deliveryMinor = delivery ? delivery.minor : 0;
  const subtotal = goods + deliveryMinor;
  const vat = Math.round(subtotal * VAT_RATE);
  return { lines, needsDelivery, delivery, goods, deliveryMinor, subtotal, vat, total: subtotal + vat };
}

/** Frequently bought together for one product, or for a whole cart (minus what is in it). */
function goesWith(skus, limit = 3) {
  const have = new Set(skus);
  const seen = new Set();
  const out = [];
  for (const sku of skus) {
    for (const g of (bySku(sku) || {}).goes || []) {
      if (!have.has(g) && !seen.has(g)) { seen.add(g); out.push(bySku(g)); }
    }
  }
  return out.filter(Boolean).slice(0, limit);
}

module.exports = {
  small, PRODUCTS, CATEGORIES, DELIVERY, VAT_RATE, gbp, bySku, bySlug, parseCart, cartString, priceCart, goesWith,
  TEASER: ['POS-1566', 'KDS-181', 'OCPP-80A', 'OCBS-T2182D', 'POS-K01', 'OCPP-80D'],
};
