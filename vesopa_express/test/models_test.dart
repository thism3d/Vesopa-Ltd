import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_express/data/models.dart';

/// Shaped exactly as vesopa_server/src/express_kiosk.js answers.
void main() {
  test('a switched-off venue: still leavable, nothing to sell', () {
    final c = KioskConfig.fromJson({
      'enabled': false,
      'kiosk': {'id': 'k1', 'name': 'By the door', 'has_card_machine': false},
      'venue': {'name': 'The Kiosk Arms', 'accent': '#A5C715'},
      'exit': {'algorithm': 'pbkdf2-sha256', 'iterations': 120000, 'salt': 's', 'hash': 'h'},
    });
    expect(c.enabled, isFalse);
    expect(c.canTakeOrders, isFalse);
    expect(c.exit?.iterations, 120000);
    expect(c.kioskName, 'By the door');
  });

  test('a working config, including a venue accent', () {
    final c = KioskConfig.fromJson({
      'enabled': true,
      'kiosk': {'id': 'k1', 'name': 'Kiosk 1', 'has_card_machine': true},
      'venue': {'name': 'Arms', 'accent': '#1E9184', 'logo_url': '/uploads/logo.png'},
      'order_types': {'eat_in': false, 'take_away': true},
      'payments': {'card': true, 'counter': false, 'demo': false, 'sandbox': true},
      'ask_name': true,
      'idle_seconds': 5,
      'welcome': {'title': 'Hello', 'subtitle': null, 'image_url': ''},
    });
    expect(c.eatIn, isFalse);
    expect(c.takeAway, isTrue);
    expect(c.payCard, isTrue);
    expect(c.sandbox, isTrue);
    expect(c.askName, isTrue);
    expect(c.idleSeconds, 20, reason: 'clamped to the server minimum');
    expect(c.accent, const Color(0xFF1E9184));
    expect(c.welcomeImage, isNull, reason: 'an empty string is no picture');
    expect(c.canTakeOrders, isTrue);
  });

  test('a menu keeps its dishes and its questions, and drops what cannot be answered', () {
    final m = KioskMenu.fromJson({
      'sections': [
        {
          'id': 1,
          'name': 'Burgers',
          'items': [
            {
              'id': 7, 'plu_id': 101, 'name': 'Cheeseburger', 'price_minor': 850,
              'available': true, 'popular': true, 'allergens': ['milk', 'gluten'],
              'allergens_declared': true,
              'add_ons': [
                {'id': 1, 'name': 'Extras', 'min_select': 0, 'max_select': 3, 'options': [
                  {'plu_id': 104, 'name': 'Extra cheese', 'price_minor': 100, 'allergens': ['milk']},
                ]},
                {'id': 2, 'name': 'Nothing', 'min_select': 1, 'max_select': 1, 'options': []},
              ],
            },
          ],
        },
        {'id': 2, 'name': 'Empty', 'items': []},
      ],
      'upsell': [7],
    });
    expect(m.sections, hasLength(1), reason: 'an empty section is not a category');
    final burger = m.itemById(7)!;
    expect(burger.addOns, hasLength(1), reason: 'a question with no answers is not asked');
    expect(burger.addOns.single.max, 1, reason: 'max cannot exceed the answers there are');
    expect(burger.allergens, ['milk', 'gluten']);
    expect(m.popular.single.name, 'Cheeseburger');
    expect(m.upsell, [7]);
  });

  test('the languages the server offers, and English when it says nothing', () {
    final base = {
      'enabled': true,
      'kiosk': {'id': 'k1', 'name': 'Kiosk 1'},
      'venue': {'name': 'Arms'},
    };
    expect(KioskConfig.fromJson(base).languages, ['en']);
    expect(KioskConfig.fromJson(base).multilingual, isFalse, reason: 'no language button to draw');
    expect(KioskConfig.fromJson({...base, 'languages': ['en']}).multilingual, isFalse);
    expect(KioskConfig.fromJson({...base, 'languages': ['en', 'cy']}).multilingual, isTrue);
    expect(KioskConfig.fromJson({...base, 'languages': ['fr', 7]}).languages, ['en'],
        reason: 'a language the kiosk has no words for is not offered');
  });

  test("the ticket: the venue's branding, and asking when the server says nothing", () {
    final base = {'enabled': true, 'kiosk': {'id': 'k1', 'name': 'K'}, 'venue': {'name': 'Arms'}};
    final none = KioskConfig.fromJson(base).receipt;
    expect(none.ask, isTrue);
    expect(none.venueName, isNull);
    final r = KioskConfig.fromJson({
      ...base,
      'receipt': {
        'mode': 'always', 'venue_name': 'The Kiosk Arms', 'address': ['1 High St', null, 'Llanelli SA14'],
        'vat_number': 'GB123', 'footer': 'Diolch!', 'phone': '',
      },
    }).receipt;
    expect(r.always, isTrue);
    expect(r.address, ['1 High St', 'Llanelli SA14']);
    expect(r.vatNumber, 'GB123');
    expect(r.phone, isNull, reason: 'an empty string is nothing to print');
    expect(KioskConfig.fromJson({...base, 'receipt': {'mode': 'sometimes'}}).receipt.ask, isTrue);
  });

  test("a dish's meals, their steps and the answers' pictures", () {
    final item = MenuItem.fromJson({
      'id': 7, 'plu_id': 101, 'name': 'Cheeseburger', 'price_minor': 1350,
      'meals': [
        {
          'plu_id': 301, 'name': 'Cheeseburger Meal', 'price_minor': 1650, 'label': 'Regular',
          'image_url': '/uploads/meal.jpg',
          'steps': [
            {'id': 2, 'name': 'Choose your side', 'min_select': 1, 'max_select': 1, 'options': [
              {'plu_id': 302, 'name': 'Chips', 'price_minor': 0, 'image_url': 'https://x/chips.jpg'},
              {'plu_id': 303, 'name': 'Sweet Potato Fries', 'price_minor': 80},
            ]},
            {'id': 9, 'name': 'Asks nothing', 'min_select': 0, 'max_select': 1, 'options': []},
          ],
        },
        {'plu_id': 304, 'name': 'Cheeseburger Large Meal', 'price_minor': 1750, 'label': 'Large', 'steps': []},
      ],
    });
    expect(item.meals, hasLength(2));
    expect(item.mealFromMinor, 1650);
    final meal = item.meals.first;
    expect(meal.label, 'Regular');
    expect(meal.imageUrl, '/uploads/meal.jpg');
    expect(meal.steps, hasLength(1), reason: 'a step with no answers is not a step');
    expect(meal.steps.single.options.first.imageUrl, 'https://x/chips.jpg');
    expect(meal.steps.single.options.last.imageUrl, isNull);
    expect(MenuItem.fromJson({'id': 1, 'name': 'Soup'}).meals, isEmpty);
    expect(MenuItem.fromJson({'id': 1, 'name': 'Soup'}).mealFromMinor, isNull);
  });

  test('every stage the server can send has a meaning here', () {
    expect(PayStage.parse('present_card'), PayStage.presentCard);
    expect(PayStage.parse('processing'), PayStage.processing);
    expect(PayStage.parse('declined').needsAnswer, isTrue);
    expect(PayStage.parse('uncertain').needsAnswer, isTrue);
    expect(PayStage.parse('unavailable').needsAnswer, isTrue);
    expect(PayStage.parse('paid').finished, isTrue);
    expect(PayStage.parse('counter').finished, isTrue);
    expect(PayStage.parse('demo').finished, isTrue);
    expect(PayStage.parse('something new'), PayStage.starting);
  });

  test('an order as the kiosk polls it', () {
    final o = OrderView.fromJson({
      'public_id': 'abc', 'number': 42, 'status': 'awaiting_payment', 'stage': 'present_card',
      'total_minor': 2200, 'tax_minor': 367, 'order_type': 'eat_in', 'payment': 'card',
      'lines': [
        {'name': 'Cheeseburger', 'qty': 2, 'unit': 850, 'isModifier': false},
        {'name': 'Extra cheese', 'qty': 2, 'unit': 100, 'isModifier': true},
      ],
    });
    expect(o.number, 42);
    expect(o.stage, PayStage.presentCard);
    expect(o.lines[1].isModifier, isTrue);
  });

  test('memberships: offered only when the server says so, and what a paid one says', () {
    final base = {'enabled': true, 'kiosk': {'id': 'k1'}, 'venue': {'name': 'Gym'}};
    expect(KioskConfig.fromJson(base).memberships, isFalse, reason: 'an older server says nothing');
    expect(KioskConfig.fromJson({...base, 'memberships': true}).memberships, isTrue);

    final o = OrderView.fromJson({
      'public_id': 'm1', 'number': 7, 'status': 'collected', 'stage': 'paid', 'total_minor': 3500,
      'order_type': 'membership',
      'lines': [{'name': 'Membership: Gold renewal', 'qty': 1, 'unit': 3500}],
      'membership': {'kind': 'renew', 'plan_name': 'Gold', 'first_name': 'Ann', 'applied': true,
          'expiry': '2026-12-04', 'member_number': null, 'failed': false},
    });
    expect(o.isMembership, isTrue);
    expect(o.membership?.applied, isTrue);
    expect(o.membership?.joining, isFalse);
    expect(o.membership?.expiry, '2026-12-04');
    expect(readableDate('2026-12-04'), '04/12/2026');
    expect(OrderView.fromJson({'order_type': 'eat_in'}).membership, isNull);

    final found = MemberFound.fromJson({
      'member_token': 't', 'first_name': 'Ann', 'plan_name': 'Gold', 'state': 'expired',
      'expiry': '2026-09-01', 'renew_minor': 3500, 'can_renew': true, 'reason': null,
    });
    expect(found.canRenew, isTrue);
    expect(found.renewMinor, 3500);
    final plan = MembershipPlan.fromJson({'id': 3, 'name': 'Gold', 'fee_minor': 3500, 'joining_fee_minor': 1000,
        'join_minor': 4500, 'term_months': 1});
    expect(plan.joinMinor, 4500);
  });

  group("the open category follows the venue's page highlight", () {
    KioskConfig config(Object? highlight) => KioskConfig.fromJson({
      'enabled': true,
      'kiosk': {'id': 'k1', 'name': 'Front'},
      'venue': {'name': 'Arms'},
      'highlight': highlight,
    });

    test('a colour the manager picked is the rail colour', () {
      expect(config({'style': 'bar', 'bar': '#e5484d'}).hereColour, const Color(0xFFE5484D));
    });

    test('the Vesopa default, the key colour, off and an old server keep lime', () {
      expect(config(null).hereColour, isNull);
      expect(config({'style': null, 'bar': null}).hereColour, isNull);
      expect(config({'style': 'fill', 'bar': 'brand'}).hereColour, isNull);
      expect(config({'style': 'bar', 'bar': 'key'}).hereColour, isNull);
      expect(config({'style': 'bar', 'bar': '#nothex'}).hereColour, isNull);
    });
  });
}
