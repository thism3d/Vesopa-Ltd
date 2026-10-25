/// A pretend venue, so Vesopa Tap can be tried, shown and tested with no
/// back office: "Try the demo" on the welcome screen. Its card payments are
/// pretend too (payments/payment_service.dart, DemoPayments) -- nothing in
/// demo mode ever reaches Dojo.
library;

import 'models.dart';

const demoVenue = Venue(name: 'The Vesopa Arms (demo)', office: 'demo', mode: VenueMode.connected);

const demoClerks = [
  Clerk(id: 1, name: 'Sam', pin: '1111', card: '04A1B2C3D4', group: 'Manager'),
  Clerk(id: 2, name: 'Alex', pin: '2222', group: 'Floor'),
  Clerk(id: 3, name: 'Priya', pin: '3333', group: 'Bar'),
];

const demoCategories = [
  MenuCategory(id: 'drinks', name: 'Drinks', colour: 0xFF2F80ED),
  MenuCategory(id: 'starters', name: 'Starters', colour: 0xFFF2994A),
  MenuCategory(id: 'mains', name: 'Mains', colour: 0xFFA5C715),
  MenuCategory(id: 'desserts', name: 'Desserts', colour: 0xFFBB6BD9),
];

const _cook = OptionGroup(name: 'Cooked', choices: [Choice('Rare'), Choice('Medium'), Choice('Well done')]);
const _side = OptionGroup(name: 'Side', choices: [Choice('Chips'), Choice('Salad'), Choice('Sweet potato fries', 150)]);

const demoProducts = [
  Product(id: 'p1', name: 'Pint of Lager', priceMinor: 550, category: 'drinks'),
  Product(id: 'p2', name: 'Pint of Bitter', priceMinor: 520, category: 'drinks'),
  Product(id: 'p3', name: 'Large Red Wine', priceMinor: 820, category: 'drinks'),
  Product(id: 'p4', name: 'Cola', priceMinor: 320, category: 'drinks'),
  Product(id: 'p5', name: 'Soup of the Day', priceMinor: 650, category: 'starters', course: 1, allergens: ['celery', 'gluten']),
  Product(id: 'p6', name: 'Garlic Bread', priceMinor: 480, category: 'starters', course: 1, allergens: ['gluten', 'milk']),
  Product(id: 'p7', name: '8oz Sirloin', priceMinor: 2450, category: 'mains', course: 2, options: [_cook, _side]),
  Product(id: 'p8', name: 'Fish & Chips', priceMinor: 1595, category: 'mains', course: 2, allergens: ['fish', 'gluten']),
  Product(id: 'p9', name: 'Vesopa Burger', priceMinor: 1495, category: 'mains', course: 2, options: [_cook, _side], allergens: ['gluten', 'milk', 'sesame']),
  Product(id: 'p10', name: 'Halloumi Salad', priceMinor: 1295, category: 'mains', course: 2, allergens: ['milk'], outOfStock: true),
  Product(id: 'p11', name: 'Sticky Toffee Pudding', priceMinor: 695, category: 'desserts', course: 3, allergens: ['gluten', 'milk', 'eggs']),
  Product(id: 'p12', name: 'Ice Cream', priceMinor: 495, category: 'desserts', course: 3, allergens: ['milk']),
];

final demoTables = [
  for (var i = 1; i <= 8; i++) TableInfo(id: 't$i', name: 'Table $i', area: 'Restaurant', seats: i.isEven ? 4 : 2),
  for (var i = 1; i <= 4; i++) TableInfo(id: 'g$i', name: 'Garden $i', area: 'Garden', seats: 6),
  const TableInfo(id: 'b1', name: 'Bar 1', area: 'Bar', seats: 2),
  const TableInfo(id: 'b2', name: 'Bar 2', area: 'Bar', seats: 2),
];
