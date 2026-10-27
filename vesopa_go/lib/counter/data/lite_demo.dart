/// The demo venue: The Vesopa Kitchen, the same menu customers see at
/// menu.vesopa.com/vesopakitchen -- its sections, items, prices, add-ons and
/// what is off today, copied from the venue's public menu on 26 Oct 2026. So the
/// demo till and the demo QR menu sell the same things at the same prices.
///
/// Only two choices are added, both ones the menu's own words promise: the
/// wings' sauce ("Buffalo or barbecue, tell us which") and how a steak is
/// cooked. Payments in the demo are pretend (Go's DemoPayments).
library;

import 'package:vesopa_go/data/demo_venue.dart' show demoManagerKeys, demoStaffKeys;
import 'package:vesopa_go/data/models.dart';

const liteDemoVenue = Venue(name: 'The Vesopa Kitchen (demo)', office: 'demo', mode: VenueMode.connected);

const liteDemoClerks = [
  Clerk(id: 1, name: 'Sam', pin: '1111', group: 'Manager', permissions: demoManagerKeys),
  Clerk(id: 2, name: 'Alex', pin: '2222', group: 'Bar', permissions: demoStaffKeys),
  Clerk(id: 3, name: 'Priya', pin: '3333', group: 'Floor', permissions: demoStaffKeys),
];

const liteDemoCategories = [
  MenuCategory(id: 'starters', name: 'Starters', colour: 0xFFF2994A),
  MenuCategory(id: 'mains', name: 'Mains', colour: 0xFFE5484D),
  MenuCategory(id: 'sides', name: 'Sides', colour: 0xFFF5B301),
  MenuCategory(id: 'puddings', name: 'Puddings', colour: 0xFFBB6BD9),
  MenuCategory(id: 'beers-cider', name: 'Beers & cider', colour: 0xFFA5C715),
  MenuCategory(id: 'wine-fizz', name: 'Wine & fizz', colour: 0xFFD6467A),
  MenuCategory(id: 'cocktails', name: 'Cocktails', colour: 0xFFE06BD0),
  MenuCategory(id: 'spirits', name: 'Spirits', colour: 0xFF8E7CF0),
  MenuCategory(id: 'soft-drinks', name: 'Soft drinks', colour: 0xFF2BB673),
  MenuCategory(id: 'coffee', name: 'Coffee', colour: 0xFFB07A4A),
  MenuCategory(id: 'tea', name: 'Tea', colour: 0xFF1E9184),
];

const _wingSauce = OptionGroup(name: 'Sauce', choices: [Choice('Buffalo'), Choice('Barbecue')]);
const _steakCooked = OptionGroup(name: 'Cooked', choices: [Choice('Rare'), Choice('Medium rare'), Choice('Medium'), Choice('Well done')]);
const _mixers = OptionGroup(name: 'Mixers', required: false, choices: [Choice('Lemonade', 80, 165), Choice('Coke', 80, 166), Choice('Fanta', 80, 167), Choice('Tonic', 80, 168)]);

const liteDemoProducts = [
  Product(id: 'p144', plu: 144, name: 'Soup of the Day', priceMinor: 650, category: 'starters'),
  Product(id: 'p145', plu: 145, name: 'Garlic Bread', priceMinor: 450, category: 'starters', outOfStock: true),
  Product(id: 'p146', plu: 146, name: 'Halloumi Fries', priceMinor: 700, category: 'starters'),
  Product(id: 'p147', plu: 147, name: 'Chicken Wings', priceMinor: 750, category: 'starters', options: [_wingSauce]),
  Product(id: 'p148', plu: 148, name: 'Bruschetta', priceMinor: 600, category: 'starters'),
  Product(id: 'p122', plu: 122, name: 'Cheeseburger', priceMinor: 1350, category: 'mains'),
  Product(id: 'p150', plu: 150, name: 'Chicken Burger', priceMinor: 1300, category: 'mains'),
  Product(id: 'p151', plu: 151, name: 'Veggie Burger', priceMinor: 1250, category: 'mains'),
  Product(id: 'p152', plu: 152, name: 'Fish & Chips', priceMinor: 1450, category: 'mains'),
  Product(id: 'p153', plu: 153, name: 'Steak & Chips', priceMinor: 2200, category: 'mains', options: [_steakCooked]),
  Product(id: 'p154', plu: 154, name: 'Margherita Pizza', priceMinor: 1150, category: 'mains'),
  Product(id: 'p155', plu: 155, name: 'Pepperoni Pizza', priceMinor: 1300, category: 'mains'),
  Product(id: 'p156', plu: 156, name: 'Caesar Salad', priceMinor: 1050, category: 'mains'),
  Product(id: 'p157', plu: 157, name: 'Chips', priceMinor: 400, category: 'sides'),
  Product(id: 'p158', plu: 158, name: 'Sweet Potato Fries', priceMinor: 480, category: 'sides'),
  Product(id: 'p159', plu: 159, name: 'Onion Rings', priceMinor: 450, category: 'sides'),
  Product(id: 'p160', plu: 160, name: 'Side Salad', priceMinor: 380, category: 'sides'),
  Product(id: 'p161', plu: 161, name: 'Sticky Toffee Pudding', priceMinor: 700, category: 'puddings'),
  Product(id: 'p162', plu: 162, name: 'Cheesecake', priceMinor: 680, category: 'puddings'),
  Product(id: 'p163', plu: 163, name: 'Chocolate Brownie', priceMinor: 650, category: 'puddings'),
  Product(id: 'p164', plu: 164, name: 'Ice Cream', priceMinor: 500, category: 'puddings'),
  Product(id: 'p123', plu: 123, name: 'Carling Half', priceMinor: 605, category: 'beers-cider', allergens: ['celery']),
  Product(id: 'p124', plu: 124, name: 'IPA Pint', priceMinor: 300, category: 'beers-cider', options: [_mixers]),
  Product(id: 'p125', plu: 125, name: 'Guinness Pint', priceMinor: 300, category: 'beers-cider'),
  Product(id: 'p126', plu: 126, name: 'Cider Pint', priceMinor: 300, category: 'beers-cider'),
  Product(id: 'p127', plu: 127, name: 'Peroni Bottle', priceMinor: 500, category: 'beers-cider'),
  Product(id: 'p128', plu: 128, name: 'House Red 175ml', priceMinor: 550, category: 'wine-fizz'),
  Product(id: 'p129', plu: 129, name: 'House White 175ml', priceMinor: 550, category: 'wine-fizz'),
  Product(id: 'p130', plu: 130, name: 'Rosé 175ml', priceMinor: 550, category: 'wine-fizz'),
  Product(id: 'p131', plu: 131, name: 'Prosecco Glass', priceMinor: 650, category: 'wine-fizz'),
  Product(id: 'p132', plu: 132, name: 'House Red Bottle', priceMinor: 2100, category: 'wine-fizz'),
  Product(id: 'p133', plu: 133, name: 'House White Bottle', priceMinor: 2100, category: 'wine-fizz'),
  Product(id: 'p139', plu: 139, name: 'Mojito', priceMinor: 950, category: 'cocktails'),
  Product(id: 'p140', plu: 140, name: 'Espresso Martini', priceMinor: 1050, category: 'cocktails'),
  Product(id: 'p141', plu: 141, name: 'Negroni', priceMinor: 1000, category: 'cocktails'),
  Product(id: 'p142', plu: 142, name: 'Aperol Spritz', priceMinor: 900, category: 'cocktails'),
  Product(id: 'p143', plu: 143, name: 'Old Fashioned', priceMinor: 1050, category: 'cocktails'),
  Product(id: 'p134', plu: 134, name: 'Gin & Tonic', priceMinor: 750, category: 'spirits'),
  Product(id: 'p135', plu: 135, name: 'Vodka & Coke', priceMinor: 750, category: 'spirits'),
  Product(id: 'p136', plu: 136, name: 'Whisky', priceMinor: 680, category: 'spirits'),
  Product(id: 'p137', plu: 137, name: 'Rum & Coke', priceMinor: 720, category: 'spirits'),
  Product(id: 'p138', plu: 138, name: 'Tequila Shot', priceMinor: 450, category: 'spirits'),
  Product(id: 'p100', plu: 100, name: 'Coca-Cola', priceMinor: 250, category: 'soft-drinks'),
  Product(id: 'p101', plu: 101, name: 'Diet Coke', priceMinor: 250, category: 'soft-drinks'),
  Product(id: 'p103', plu: 103, name: 'Orange Juice', priceMinor: 280, category: 'soft-drinks'),
  Product(id: 'p104', plu: 104, name: 'Apple Juice', priceMinor: 280, category: 'soft-drinks'),
  Product(id: 'p105', plu: 105, name: 'Sparkling Water', priceMinor: 190, category: 'soft-drinks'),
  Product(id: 'p106', plu: 106, name: 'Still Water', priceMinor: 170, category: 'soft-drinks'),
  Product(id: 'p107', plu: 107, name: 'Ginger Beer', priceMinor: 290, category: 'soft-drinks'),
  Product(id: 'p108', plu: 108, name: 'Espresso', priceMinor: 220, category: 'coffee'),
  Product(id: 'p109', plu: 109, name: 'Double Espresso', priceMinor: 280, category: 'coffee'),
  Product(id: 'p110', plu: 110, name: 'Americano', priceMinor: 270, category: 'coffee'),
  Product(id: 'p111', plu: 111, name: 'Latte', priceMinor: 320, category: 'coffee'),
  Product(id: 'p112', plu: 112, name: 'Cappuccino', priceMinor: 320, category: 'coffee'),
  Product(id: 'p113', plu: 113, name: 'Flat White', priceMinor: 330, category: 'coffee'),
  Product(id: 'p114', plu: 114, name: 'Mocha', priceMinor: 360, category: 'coffee'),
  Product(id: 'p115', plu: 115, name: 'Hot Chocolate', priceMinor: 340, category: 'coffee'),
  Product(id: 'p116', plu: 116, name: 'English Breakfast', priceMinor: 240, category: 'tea'),
  Product(id: 'p117', plu: 117, name: 'Earl Grey', priceMinor: 240, category: 'tea'),
  Product(id: 'p118', plu: 118, name: 'Green Tea', priceMinor: 260, category: 'tea'),
  Product(id: 'p119', plu: 119, name: 'Peppermint', priceMinor: 260, category: 'tea'),
  Product(id: 'p120', plu: 120, name: 'Chamomile', priceMinor: 260, category: 'tea'),
  Product(id: 'p121', plu: 121, name: 'Chai Latte', priceMinor: 340, category: 'tea'),
];
