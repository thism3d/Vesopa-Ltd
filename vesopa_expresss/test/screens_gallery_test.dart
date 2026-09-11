// Every customer screen, drawn with the real fonts, in both orientations.
//
// Not a golden test in the "fail on one pixel" sense -- the kiosk's design is
// still moving -- but the same machinery, used to produce a picture of every
// screen that can be LOOKED AT. Several faults on this platform were only ever
// visible in a screenshot, so this is how the kiosk's layouts get looked at:
//
//   flutter test test/screens_gallery_test.dart --update-goldens
//
// writes test/gallery/*.png. Each case also fails if Flutter reports an
// overflow while drawing it, which is the layout fault a picture shows last.

// The notifiers' `state` is set directly below to put each screen up.
// ignore_for_file: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member

@Tags(['gallery'])
library;

import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_express/data/basket.dart';
import 'package:vesopa_express/data/models.dart';
import 'package:vesopa_express/data/order_flow.dart';
import 'package:vesopa_express/data/passcode.dart';
import 'package:vesopa_express/data/session.dart';
import 'package:vesopa_express/l10n/strings.dart';
import 'package:vesopa_express/ui/app.dart';
import 'package:vesopa_express/ui/pages/ordering.dart';

const _cheese = AddOnOption(pluId: 104, name: 'Extra cheese', priceMinor: 100, allergens: ['milk']);
const _bacon = AddOnOption(pluId: 105, name: 'Smoked bacon', priceMinor: 150);
const _jalapeno = AddOnOption(pluId: 106, name: 'Jalapeños', priceMinor: 60);

const _burger = MenuItem(
  id: 1, pluId: 101, name: 'The Bridge Cheeseburger', priceMinor: 1150, popular: true,
  description: 'Two smashed Welsh beef patties, Caerphilly cheese, pickles and burger sauce in a toasted brioche bun.',
  allergens: ['gluten', 'milk', 'eggs', 'mustard'], allergensDeclared: true,
  addOns: [AddOnGroup(id: 1, name: 'Make it yours', min: 0, max: 3, options: [_cheese, _bacon, _jalapeno])],
);
const _chicken = MenuItem(id: 2, pluId: 102, name: 'Buttermilk Chicken Burger', priceMinor: 1095,
    allergens: ['gluten', 'eggs'], allergensDeclared: true);
const _vegan = MenuItem(id: 3, pluId: 103, name: 'Beetroot & Bean Burger', priceMinor: 995, diet: 'vegan',
    allergensDeclared: true);
const _pie = MenuItem(id: 4, pluId: 107, name: 'Steak & Ale Pie', priceMinor: 1395, available: false);
const _fries = MenuItem(id: 5, pluId: 108, name: 'Skin-on Fries', priceMinor: 395, popular: true,
    allergensDeclared: true, diet: 'vegan');
const _rings = MenuItem(id: 6, pluId: 109, name: 'Onion Rings', priceMinor: 450, allergens: ['gluten']);
const _cola = MenuItem(id: 7, pluId: 110, name: 'Coca-Cola 330ml', priceMinor: 250, allergensDeclared: true);
const _shake = MenuItem(id: 8, pluId: 111, name: 'Salted Caramel Shake', priceMinor: 475, allergens: ['milk']);

const _menu = KioskMenu(
  sections: [
    MenuSection(id: 1, name: 'Burgers', blurb: 'All served with fries', items: [_burger, _chicken, _vegan, _pie]),
    MenuSection(id: 2, name: 'Sides', items: [_fries, _rings]),
    MenuSection(id: 3, name: 'Drinks', items: [_cola, _shake]),
  ],
  upsell: [6, 8],
);

const _config = KioskConfig(
  enabled: true,
  kioskId: 'k1',
  kioskName: 'Kiosk by the door',
  hasCardMachine: true,
  venueName: 'The Bridge, Llangennech',
  accent: Color(0xFFA5C715),
  eatIn: true,
  takeAway: true,
  payCard: true,
  payCounter: true,
  sandbox: true,
  askName: true,
  exit: ExitCheck(salt: 's', hash: 'h', iterations: 1000),
);

class _FakeSession extends KioskSession {
  _FakeSession(this.initial);
  final KioskState initial;

  @override
  KioskState build() => initial;

  @override
  Future<void> refresh({bool withMenu = true}) async {}
}

Future<void> _loadFonts() async {
  Future<void> family(String name, List<String> files) async {
    final loader = FontLoader(name);
    for (final f in files) {
      loader.addFont(rootBundle.load('assets/fonts/$f'));
    }
    await loader.load();
  }

  await family('Montserrat', [
    'Montserrat-Regular.ttf', 'Montserrat-Medium.ttf', 'Montserrat-SemiBold.ttf',
    'Montserrat-Bold.ttf', 'Montserrat-ExtraBold.ttf',
  ]);
  await family('Orbitron', ['Orbitron-Bold.ttf', 'Orbitron-ExtraBold.ttf']);

  // The icons, from the SDK the test is running under.
  var dir = File(Platform.resolvedExecutable).parent;
  while (dir.path != dir.parent.path && !Directory('${dir.path}/artifacts/material_fonts').existsSync()) {
    dir = dir.parent;
  }
  final icons = File('${dir.path}/artifacts/material_fonts/MaterialIcons-Regular.otf');
  if (icons.existsSync()) {
    final loader = FontLoader('MaterialIcons')
      ..addFont(Future.value(ByteData.sublistView(icons.readAsBytesSync())));
    await loader.load();
  }
}

void main() {
  setUpAll(_loadFonts);

  final shots = <(String, Size, FlowState, KioskState?)>[];
  const basket = Basket([
    BasketLine(item: _burger, addOns: [_cheese, _bacon], qty: 2),
    BasketLine(item: _fries),
    BasketLine(item: _cola, qty: 2),
  ]);
  const ready = KioskState(phase: Phase.ready, config: _config, menu: _menu);
  const paying = OrderView(
    publicId: 'p', number: 42, status: 'awaiting_payment', stage: PayStage.presentCard, totalMinor: 3490,
  );

  for (final (orientation, size) in const [
    ('portrait', Size(1080, 1920)),
    ('landscape', Size(1920, 1080)),
    // The first live run was at this size, and it is where the choice cards
    // overflowed. A kiosk window, a small tablet, a phone.
    ('small', Size(540, 960)),
    ('smallwide', Size(960, 540)),
  ]) {
    shots.addAll([
      ('${orientation}_01_attract', size, const FlowState(), null),
      ('${orientation}_02_order_type', size, const FlowState(step: FlowStep.orderType), null),
      ('${orientation}_03_menu', size, const FlowState(step: FlowStep.menu, orderType: 'eat_in', basket: basket), null),
      ('${orientation}_05_basket', size,
          const FlowState(step: FlowStep.basket, orderType: 'eat_in', basket: basket), null),
      ('${orientation}_06_name', size,
          const FlowState(step: FlowStep.details, orderType: 'eat_in', basket: basket, name: 'Rhys'), null),
      ('${orientation}_07_pay_method', size,
          const FlowState(step: FlowStep.payMethod, orderType: 'eat_in', basket: basket), null),
      ('${orientation}_08_paying', size,
          const FlowState(step: FlowStep.paying, orderType: 'eat_in', basket: basket, order: paying), null),
      ('${orientation}_09_declined', size, FlowState(
        step: FlowStep.paying, orderType: 'eat_in', basket: basket,
        order: OrderView(publicId: 'p', number: 42, status: 'awaiting_payment', stage: PayStage.declined,
            totalMinor: 3490, message: 'The card was declined.'),
      ), null),
      ('${orientation}_10_done', size, const FlowState(
        step: FlowStep.done, orderType: 'eat_in',
        order: OrderView(publicId: 'p', number: 42, status: 'paid', stage: PayStage.paid, totalMinor: 3490,
            orderType: 'eat_in', customerName: 'Rhys'),
      ), null),
      ('${orientation}_11_closed', size, const FlowState(),
          const KioskState(phase: Phase.off, config: _config, menu: _menu)),
      ('${orientation}_12_setup', size, const FlowState(), const KioskState(phase: Phase.setup)),
    ]);
  }
  shots.addAll([
    ('portrait_20_menu_welsh', const Size(1080, 1920),
        const FlowState(step: FlowStep.menu, orderType: 'take_away', basket: basket, lang: Lang.cy), null),
    ('portrait_21_menu_high_contrast', const Size(1080, 1920),
        const FlowState(step: FlowStep.menu, orderType: 'take_away', basket: basket, contrast: true), null),
    ('portrait_22_menu_reach', const Size(1080, 1920),
        const FlowState(step: FlowStep.menu, orderType: 'take_away', basket: basket, reach: true), null),
    ('portrait_23_attract_welsh', const Size(1080, 1920), const FlowState(lang: Lang.cy), null),
    ('tablet_24_menu', const Size(1280, 800),
        const FlowState(step: FlowStep.menu, orderType: 'eat_in', basket: basket), null),
  ]);

  for (final (name, size, flow, session) in shots) {
    testWidgets(name, (tester) async {
      SharedPreferences.setMockInitialValues({});
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(ProviderScope(
        overrides: [kioskSessionProvider.overrideWith(() => _FakeSession(session ?? ready))],
        child: const ExpressApp(),
      ));
      await tester.pump();
      final container = ProviderScope.containerOf(tester.element(find.byType(ExpressApp)));
      container.read(orderFlowProvider.notifier).state = flow;
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump(const Duration(milliseconds: 400));

      await expectLater(find.byType(ExpressApp), matchesGoldenFile('gallery/$name.png'));
    });
  }

  testWidgets('portrait_04_item_sheet', (tester) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(1080, 1920);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(ProviderScope(
      overrides: [kioskSessionProvider.overrideWith(() => _FakeSession(ready))],
      child: const ExpressApp(),
    ));
    await tester.pump();
    final container = ProviderScope.containerOf(tester.element(find.byType(ExpressApp)));
    container.read(orderFlowProvider.notifier).state =
        const FlowState(step: FlowStep.menu, orderType: 'eat_in');
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    // The attract screen's teaser names the same dish while it fades out, so
    // the tap is aimed at the menu's own card.
    await tester.tap(find.descendant(of: find.byType(ItemCard), matching: find.text('The Bridge Cheeseburger')).first);
    for (var i = 0; i < 12; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.tap(find.text('Extra cheese'));
    await tester.pump(const Duration(milliseconds: 300));
    await expectLater(find.byType(ExpressApp), matchesGoldenFile('gallery/portrait_04_item_sheet.png'));

    // And it adds what was chosen, at the price shown.
    await tester.tap(find.textContaining('Add to order'));
    for (var i = 0; i < 12; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    final line = container.read(orderFlowProvider).basket.lines.single;
    expect(line.addOns.single.name, 'Extra cheese');
    expect(line.totalMinor, 1250);
  });
}
