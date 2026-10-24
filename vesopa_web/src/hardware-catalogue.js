'use strict';

/**
 * The hardware Vesopa sells, for the home page teaser and /hardware.
 *
 * Supplier: OCOM Technologies (ocominc.com); specs from their product pages and
 * the KDS-181 spec sheet, collected 2026-10-24 (docs/hardware/ocom-products.json).
 * Prices are Vesopa's retail prices, ex VAT. Supplier cost prices are never
 * here. `stock: 'in'` = already in the UK (Meirion's order PI2606112: POS-1566
 * tills and OCPP-80A printers); everything else ships in 7-10 days.
 *
 * Photos: the brochure's, with the supplier's logo painted out and the Vesopa
 * wordmark on the bezel (Meirion: the supplier brand is covered with ours).
 */
const IMG = '/assets/v2/';

const PRODUCTS = [
  {
    sku: 'POS-1566', cat: 'till', name: 'Vesopa Till 15.6" Pro', runs: 'Vesopa EPOS', price: 599, stock: 'in',
    img: IMG + 'till-1566.jpg', short: 'Intel i5, 8GB, 128GB SSD',
    headline: 'Splash-resistant till with a tilting screen and room for a customer display.',
    specs: [
      ['Screen', '15.6" 1366x768, 250 cd/m2, projected capacitive touch'],
      ['Customer display', '11.6" second screen or 2x20 VFD (optional)'],
      ['Processor', 'Intel Core i5'],
      ['Memory and storage', '8GB RAM, 128GB SSD'],
      ['System', 'Windows 10/11 Pro'],
      ['Ports', 'USB 3.0 x2, USB 2.0 x4, COM, HDMI, Gigabit LAN'],
      ['Wireless', 'Wi-Fi 2.4/5GHz and Bluetooth 5.0 (optional)'],
      ['Weight', '3.5 kg'],
      ['Warranty', '12 months, supported by Vesopa'],
    ],
  },
  {
    sku: 'POS-1562', cat: 'till', name: 'Vesopa Till 15.6" Super-Slim', runs: 'Vesopa EPOS', price: 599, stock: 'lead',
    img: IMG + 'till-1562.jpg', short: 'Die-cast aluminium, Celeron J6412',
    headline: 'Die-cast aluminium and super slim, and it keeps trading when the broadband drops.',
    specs: [
      ['Screen', '15.6" 1366x768, projected capacitive touch'],
      ['Customer display', '11.6" second screen (optional)'],
      ['Processor', 'Intel Celeron J6412 2.0GHz (Core i3 optional)'],
      ['Memory and storage', '4GB DDR4 (8/16GB optional), 64GB M.2 SSD and up'],
      ['System', 'Windows 10/11'],
      ['Ports', 'USB x6, COM x2, HDMI, Gigabit LAN'],
      ['Body', 'Aluminium alloy housing and base'],
      ['Weight', '3.6 kg'],
      ['Warranty', '12 months, supported by Vesopa'],
    ],
  },
  {
    sku: 'KDS-181', cat: 'kitchen', name: 'Vesopa Kitchen Screen 18.5"', runs: 'Vesopa Kitchen', price: 449, stock: 'lead',
    img: IMG + 'kds-181.jpg', short: 'Celeron J4125, 128GB SSD',
    headline: 'The pass without the paper: tickets from the till with the wait time and a loud new-order beep.',
    specs: [
      ['Screen', '18.5" 1366x768, 250 cd/m2, 178 degree viewing, capacitive touch'],
      ['Processor', 'Intel Celeron J4125 quad-core 2.0GHz'],
      ['Memory and storage', '4GB DDR4, 128GB SSD'],
      ['System', 'Windows 10 Pro'],
      ['Network', 'Gigabit LAN, Wi-Fi, Bluetooth 4.0'],
      ['Ports', 'USB x4, RJ-45'],
      ['Speaker', '3W, for the new-order alert'],
      ['Size and weight', '456 x 277 x 57 mm, 4.5 kg'],
      ['Warranty', '12 months, supported by Vesopa'],
    ],
  },
  {
    sku: 'KDS-151', cat: 'kitchen', name: 'Vesopa Kitchen Screen 15"', runs: 'Vesopa Kitchen', price: 379, stock: 'lead',
    img: IMG + 'kds-151.jpg', short: 'Compact, pairs itself',
    headline: 'The compact screen for smaller kitchens, bars and prep stations. It finds the till and pairs itself.',
    specs: [
      ['Screen', '15" touch'],
      ['Pairing', 'Finds the till on the network, no IP addresses to type'],
      ['System', 'Windows'],
      ['Warranty', '12 months, supported by Vesopa'],
    ],
  },
  {
    sku: 'OCPP-80A', cat: 'printer', name: 'Vesopa Receipt Printer 80mm', runs: 'Vesopa EPOS', price: 129, stock: 'in',
    img: IMG + 'printer-80a.jpg', short: 'USB + LAN, auto cutter',
    headline: 'Receipts with your logo and the end-of-day reports, fast and sharp.',
    specs: [
      ['Printing', 'Direct thermal, 203 dpi, up to 260 mm/s'],
      ['Paper', '80 mm rolls, up to 80 mm across'],
      ['Cutter', 'Auto cutter, 1 million cuts'],
      ['Connection', 'USB and LAN (serial, Wi-Fi or Bluetooth options)'],
      ['Codes', 'Barcodes and QR codes on receipts'],
      ['Size and weight', '160 x 135 x 125 mm, 0.8 kg'],
      ['Warranty', '12 months, supported by Vesopa'],
    ],
  },
  {
    sku: 'OCPP-80D', cat: 'printer', name: 'Vesopa Kitchen Printer 80mm', runs: 'Vesopa EPOS', price: 149, stock: 'lead',
    img: IMG + 'printer-80d.jpg', short: 'Flashing light + loud beeper',
    headline: 'A proper kitchen printer: flashing light and loud beeper, wall-mountable.',
    specs: [
      ['Printing', 'Direct thermal, 203 dpi, 300 mm/s'],
      ['Kitchen alert', 'Flashing LED and loud beeper'],
      ['Cutter', 'Japanese mechanism, 1.5 million cuts'],
      ['Connection', 'Serial, USB and LAN (Wi-Fi or Bluetooth options)'],
      ['Mounting', 'Desk or wall, bracket built in'],
      ['Cash drawer', '24V kick-out port'],
      ['Size and weight', '186 x 143 x 140 mm, 1.0 kg'],
      ['Warranty', '12 months, supported by Vesopa'],
    ],
  },
  {
    sku: 'OCBS-T2182D', cat: 'scanner', name: 'Vesopa Barcode Scanner', runs: 'Vesopa EPOS', price: 69, stock: 'lead',
    img: '', short: '1D + QR, USB',
    headline: 'Scan products, gift cards and vouchers straight onto the bill.',
    specs: [
      ['Reads', '1D barcodes and 2D QR codes'],
      ['Connection', 'USB, plug and play'],
      ['Warranty', '12 months, supported by Vesopa'],
    ],
  },
  {
    sku: 'POS-K01', cat: 'kiosk', name: 'Vesopa Self-Service Kiosk', runs: 'Vesopa Express', price: 1499, stock: 'lead',
    img: IMG + 'kiosk.jpg', short: '21.5" Full HD, printer, scanner',
    headline: 'Order here, skip the queue: the menu in pictures, meal deals and card payment at the kiosk.',
    specs: [
      ['Screen', '21.5" Full HD IPS, 10-point touch (27" and 32" on request)'],
      ['Processor', 'Intel Celeron N5095 (Core i3/i5 optional)'],
      ['Memory and storage', '8GB DDR4, 128GB SSD'],
      ['System', 'Windows 10/11'],
      ['Printer', '80 mm thermal with auto cutter'],
      ['Scanner', '1D/2D scanning window for vouchers and QR codes'],
      ['Card payments', 'Bracket for the card machine, NFC option'],
      ['Mounting', 'Floor stand, wall or counter'],
      ['Warranty', '12 months, supported by Vesopa'],
    ],
  },
];

const CATEGORIES = [
  ['all', 'All hardware'], ['till', 'Tills'], ['kitchen', 'Kitchen screens'],
  ['printer', 'Printers'], ['scanner', 'Scanners'], ['kiosk', 'Kiosks'],
];

const gbp = (n) => '£' + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 });

module.exports = { PRODUCTS, CATEGORIES, gbp, TEASER: ['POS-1566', 'KDS-181', 'OCPP-80A', 'POS-K01'] };
