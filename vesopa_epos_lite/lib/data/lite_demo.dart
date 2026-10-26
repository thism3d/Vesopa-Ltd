/// A pretend bar and kitchen, so Vesopa EPOS Lite can be tried and shown with
/// no back office: "Try the demo". It is the kind of venue Lite is for -- a
/// festival bar, a pop-up, a beer garden -- with portions, a set menu and
/// allergens, so every part of the sale screen has something to show.
/// Payments in the demo are pretend (vesopa_tap's DemoPayments).
library;

import 'package:vesopa_tap/data/models.dart';

const liteDemoVenue = Venue(name: 'The Vesopa Bar (demo)', office: 'demo', mode: VenueMode.standalone);

const liteDemoClerks = [
  Clerk(id: 1, name: 'Sam', pin: '1111', group: 'Manager'),
  Clerk(id: 2, name: 'Alex', pin: '2222', group: 'Bar'),
  Clerk(id: 3, name: 'Priya', pin: '3333', group: 'Bar'),
];

const liteDemoCategories = [
  MenuCategory(id: 'draught', name: 'Draught', colour: 0xFFA5C715),
  MenuCategory(id: 'bottles', name: 'Bottles', colour: 0xFF3E8CF0),
  MenuCategory(id: 'spirits', name: 'Spirits', colour: 0xFFBB6BD9),
  MenuCategory(id: 'soft', name: 'Soft drinks', colour: 0xFF2BB673),
  MenuCategory(id: 'starters', name: 'Starters', colour: 0xFFF2994A),
  MenuCategory(id: 'mains', name: 'Mains', colour: 0xFFE5484D),
  MenuCategory(id: 'specials', name: 'Specials', colour: 0xFFF5B301),
];

/// A pint is the price; a half takes some off, as a portion on the till does.
const _pint = OptionGroup(name: 'Portion', choices: [Choice('Pint'), Choice('Half', -230)]);
const _soft = OptionGroup(name: 'Size', choices: [Choice('Standard'), Choice('Small', -106)]);
const _single = OptionGroup(name: 'Measure', choices: [Choice('Single'), Choice('Double', 250)]);
const _mixer = OptionGroup(name: 'Mixer', required: false, choices: [Choice('Coke', 80), Choice('Lemonade', 80), Choice('Tonic', 90), Choice('Neat')]);
const _cook = OptionGroup(name: 'Cooked', choices: [Choice('Rare'), Choice('Medium'), Choice('Well done')]);

const _setStarter = OptionGroup(name: 'Starter', choices: [
  Choice('Soup of the Day'),
  Choice('Potted Shrimps'),
  Choice('Terrine of Chicken'),
  Choice('Tempura Tiger Prawns'),
  Choice('Garlic Mushrooms'),
  Choice('Chicken Goujons'),
]);
const _setMain = OptionGroup(name: 'Main', choices: [Choice('Sirloin', 400), Choice('Halibut'), Choice('Gammon'), Choice('Lamb'), Choice('Ratatouille')]);
const _setDessert = OptionGroup(name: 'Dessert', choices: [Choice('Sticky Toffee Pudding'), Choice('Ice Cream'), Choice('Cheeseboard', 200)]);

Product _p(String id, String name, int price, String cat, {List<OptionGroup> options = const [], List<String> allergens = const [], bool out = false}) =>
    Product(id: id, name: name, priceMinor: price, category: cat, options: options, allergens: allergens, outOfStock: out);

final liteDemoProducts = [
  _p('d1', 'Fortyniner', 480, 'draught', options: [_pint], allergens: ['gluten']),
  _p('d2', 'Ringwood Best', 460, 'draught', options: [_pint], allergens: ['gluten']),
  _p('d3', 'Foggie Dew', 490, 'draught', options: [_pint], allergens: ['gluten']),
  _p('d4', 'Ale of Wight', 470, 'draught', options: [_pint], allergens: ['gluten']),
  _p('d5', 'Fosters', 420, 'draught', options: [_pint], allergens: ['gluten']),
  _p('d6', 'Guinness', 520, 'draught', options: [_pint], allergens: ['gluten']),
  _p('d7', 'Cider', 450, 'draught', options: [_pint], allergens: ['sulphites']),
  _p('b1', 'Becks', 380, 'bottles', allergens: ['gluten']),
  _p('b2', 'Budweiser', 360, 'bottles', allergens: ['gluten']),
  _p('b3', 'Corona', 400, 'bottles', allergens: ['gluten']),
  _p('b4', 'Sol', 360, 'bottles', allergens: ['gluten']),
  _p('b5', 'Red Stripe', 380, 'bottles', allergens: ['gluten']),
  _p('b6', 'Alcohol-free Lager', 340, 'bottles', allergens: ['gluten'], out: true),
  _p('s1', 'Whisky', 380, 'spirits', options: [_single, _mixer]),
  _p('s2', 'Vodka', 360, 'spirits', options: [_single, _mixer]),
  _p('s3', 'Gin', 380, 'spirits', options: [_single, _mixer]),
  _p('s4', 'White Rum', 360, 'spirits', options: [_single, _mixer]),
  _p('s5', 'Dark Rum', 370, 'spirits', options: [_single, _mixer]),
  _p('c1', 'Coke', 220, 'soft', options: [_soft]),
  _p('c2', 'Diet Coke', 220, 'soft', options: [_soft]),
  _p('c3', 'Lemonade', 200, 'soft', options: [_soft]),
  _p('c4', 'J2O', 280, 'soft'),
  _p('c5', 'Fruit Shoot', 180, 'soft'),
  _p('c6', 'Pint of Cola', 340, 'soft'),
  _p('f1', 'Soup of the Day', 650, 'starters', allergens: ['celery', 'gluten']),
  _p('f2', 'Potted Shrimps', 795, 'starters', allergens: ['crustaceans', 'milk']),
  _p('f3', 'Garlic Mushrooms', 695, 'starters', allergens: ['gluten', 'milk']),
  _p('f4', 'Chicken Goujons', 725, 'starters', allergens: ['gluten', 'eggs']),
  _p('m1', 'Sirloin', 2450, 'mains', options: [_cook]),
  _p('m2', 'Halibut', 1895, 'mains', allergens: ['fish', 'milk']),
  _p('m3', 'Gammon', 1495, 'mains', allergens: ['eggs']),
  _p('m4', 'Lamb', 1995, 'mains', allergens: ['celery']),
  _p('m5', 'Ratatouille', 1295, 'mains'),
  _p('m6', 'Puff Pastry Tart', 1395, 'mains', allergens: ['gluten', 'milk', 'eggs']),
  _p('x1', 'Three Course Meal', 2500, 'specials', options: [_setStarter, _setMain, _setDessert], allergens: ['varies: check the dishes']),
  _p('x2', 'Burger & a Pint', 1500, 'specials', options: [_cook], allergens: ['gluten', 'milk', 'sesame']),
];
