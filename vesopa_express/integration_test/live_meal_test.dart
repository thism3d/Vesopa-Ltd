// A meal, from the real app, on the real server, paid on the Dojo sandbox
// card machine -- and its ticket printed on a network printer that is really a
// listener on this machine, so what the printer would have been sent can be
// read back.
//
// The TEST venue only (manager@vesopa.co.uk), with a kiosk token minted on the
// server, as live_kiosk_test.dart does:
//
//   ssh:  node tool/verify-express-live.js --hold          (token in tmp/)
//   here: python tool/fake_printer.py <ticket.bin> 9107     (in the background)
//         flutter test integration_test/live_meal_test.dart -d windows ^
//           --dart-define=EXPRESS_TOKEN=<that token> ^
//           --dart-define=EXPRESS_SHOTS=<folder> ^
//           --dart-define=EXPRESS_TICKET=<ticket.bin> ^
//           [--dart-define=EXPRESS_SHOT_RATIO=2]              (4K from 1920 x 1080)
//   ssh:  node tool/verify-express-live.js --release        (removes every row it made)
//
// It runs the kiosk full screen, as it runs in a venue, so the pictures are
// the kiosk's real landscape screens -- these are the Store's screenshots.

import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_express/config/constants.dart';
import 'package:vesopa_express/data/order_flow.dart';
import 'package:vesopa_express/platform/kiosk_window.dart';
import 'package:vesopa_express/ui/app.dart';
import 'package:vesopa_express/ui/pages/ordering.dart';

const _shots = String.fromEnvironment('EXPRESS_SHOTS');
const _ticket = String.fromEnvironment('EXPRESS_TICKET');
const _ratio = String.fromEnvironment('EXPRESS_SHOT_RATIO', defaultValue: '1.5');
// Not 9100 on a development machine: Dart's DevTools server listens there.
const _port = int.fromEnvironment('EXPRESS_PRINTER_PORT', defaultValue: 9107);
// Lay the kiosk out at this size whatever the window is -- "1080x1920" draws a
// portrait kiosk on a landscape development screen, for the portrait pictures.
const _layout = String.fromEnvironment('EXPRESS_LAYOUT');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final frame = GlobalKey();

  Future<void> shot(WidgetTester tester, String name) async {
    if (_shots.isEmpty) return;
    await tester.pump(const Duration(milliseconds: 300));
    await tester.runAsync(() async {
      final boundary = frame.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: double.parse(_ratio));
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      final file = File('$_shots/$name.png');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(png!.buffer.asUint8List());
    });
  }

  /// Real time passing, frames drawn, until [finder] finds something. On a
  /// timeout the screen is photographed first: what was on it is the answer.
  Future<void> waitFor(WidgetTester tester, Finder finder, {int seconds = 30}) async {
    final end = DateTime.now().add(Duration(seconds: seconds));
    while (DateTime.now().isBefore(end)) {
      await tester.pump(const Duration(milliseconds: 200));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      if (finder.evaluate().isNotEmpty) return;
    }
    await shot(tester, 'failed_${DateTime.now().millisecondsSinceEpoch}');
    throw TestFailure('Timed out waiting for $finder');
  }

  /// Let the pictures arrive: they come over the network, like a venue's.
  Future<void> pictures(WidgetTester tester, [int seconds = 3]) async {
    for (var i = 0; i < seconds * 4; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 250)));
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  testWidgets('a meal, paid on the sandbox machine, and its ticket printed', (tester) async {
    expect(ExpressConfig.seedToken, isNotEmpty, reason: 'pass --dart-define=EXPRESS_TOKEN');
    SharedPreferences.setMockInitialValues({
      if (_ticket.isNotEmpty)
        'express_ticket_printer': jsonEncode({'kind': 'network', 'host': '127.0.0.1', 'port': _port}),
    });
    await KioskWindow.lock();
    if (_layout.contains('x')) {
      final [w, h] = _layout.split('x').map(double.parse).toList();
      tester.view.physicalSize = Size(w, h);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
    }

    await tester.pumpWidget(
      RepaintBoundary(key: frame, child: const ProviderScope(child: ExpressApp())),
    );

    await waitFor(tester, find.text('Touch to start'));
    await pictures(tester, 4);
    await shot(tester, 'store_01_attract');

    await tester.tap(find.text('Touch to start'));
    await waitFor(tester, find.text('Take away'));
    await shot(tester, 'store_02_order_type');
    await tester.tap(find.text('Take away'));
    await waitFor(tester, find.byType(ItemCard));

    // The mains: the burgers, with their meals.
    await tester.tap(find.text('Mains').first);
    await waitFor(tester, find.text('Cheeseburger'));
    await pictures(tester, 4);
    await shot(tester, 'store_03_menu');

    await tester.tap(find.descendant(of: find.byType(ItemCard), matching: find.text('Cheeseburger')).first);
    await waitFor(tester, find.text('Make it a meal'));
    await pictures(tester, 2);
    await tester.ensureVisible(find.text('Make it a meal').last);
    await pictures(tester, 1);
    await shot(tester, 'store_04_dish');

    await tester.tap(find.text('Make it a meal').last);
    await waitFor(tester, find.text('Choose your size'));
    await pictures(tester, 2);
    await shot(tester, 'store_05_meal_size');
    await tester.tap(find.text('Regular').last);

    await waitFor(tester, find.text('Choose your side'));
    await pictures(tester, 3);
    await tester.tap(find.text('Chips').last);
    await tester.pump(const Duration(milliseconds: 150));
    await shot(tester, 'store_06_meal_side');

    await waitFor(tester, find.text('Choose your drink'));
    await pictures(tester, 3);
    await tester.tap(find.text('Coca-Cola').last);
    await tester.pump(const Duration(milliseconds: 150));
    await shot(tester, 'store_07_meal_drink');

    await waitFor(tester, find.byKey(const ValueKey('add-meal')));
    await pictures(tester, 1);
    await shot(tester, 'store_08_meal_review');
    await tester.tap(find.byKey(const ValueKey('add-meal')));
    await waitFor(tester, find.text('Review order'));
    await tester.pump(const Duration(milliseconds: 800));

    // Something from the starters, so the basket reads like an order.
    await tester.tap(find.text('Starters').first);
    await waitFor(tester, find.text('Halloumi Fries'));
    await pictures(tester, 2);
    await tester.tap(find.descendant(of: find.byType(ItemCard), matching: find.text('Halloumi Fries')).first);
    await waitFor(tester, find.textContaining('Add to order'));
    await tester.tap(find.textContaining('Add to order'));
    await tester.pump(const Duration(milliseconds: 800));

    final element = tester.element(find.byType(ExpressApp));
    final container = ProviderScope.containerOf(element);
    final basket = container.read(orderFlowProvider).basket;
    expect(basket.lines, hasLength(2));
    final meal = basket.lines.firstWhere((l) => l.meal != null);
    expect(meal.meal!.name, 'Cheeseburger Meal');
    expect(meal.addOns.map((a) => a.name), ['Chips', 'Coca-Cola']);

    // The basket's own button: "Review order" is also the action on the
    // snackbar that says the dish was added, which may be leaving the screen.
    await tester.pump(const Duration(seconds: 2));
    await tester.tap(find.widgetWithText(FilledButton, 'Review order').first);
    await waitFor(tester, find.textContaining('Pay now'));
    await pictures(tester, 2);
    await shot(tester, 'store_09_basket');
    await tester.tap(find.textContaining('Pay now'));

    // The test venue asks for a name while held.
    await waitFor(tester, find.textContaining('What name'), seconds: 10);
    for (final l in ['S', 'A', 'M']) {
      await tester.tap(find.text(l));
      await tester.pump(const Duration(milliseconds: 80));
    }
    await shot(tester, 'store_10_name');
    await tester.tap(find.text('Continue'));

    await waitFor(tester, find.text('Pay by card here'));
    await shot(tester, 'store_11_pay_method');
    await tester.tap(find.text('Pay by card here'));

    await waitFor(tester, find.textContaining('your card'), seconds: 40);
    await shot(tester, 'store_12_paying');

    // The sandbox machine approves by itself; a real one waits for a card.
    await waitFor(tester, find.text('Thank you!'), seconds: 150);
    await shot(tester, 'store_13_done');

    final order = container.read(orderFlowProvider).order!;
    expect(order.number, greaterThan(0));
    // Priced by the server from the meal product, exactly as the basket showed.
    expect(order.totalMinor, basket.totalMinor, reason: 'the server charged what the kiosk showed');
    expect(order.lines.first.name, 'Cheeseburger Meal');
    // ignore: avoid_print
    print('LIVE MEAL ORDER ${order.number} paid, ${order.totalMinor}p');

    if (_ticket.isNotEmpty) {
      await tester.tap(find.text('Print a receipt'));
      await waitFor(tester, find.text('Your receipt is printing'), seconds: 20);
      await shot(tester, 'store_14_done_printing');
      // The listener writes what it was sent; give it a moment to close.
      await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 2)));
      final sent = latin1.decode(await File(_ticket).readAsBytes(), allowInvalid: true);
      expect(sent, contains('YOUR ORDER NUMBER'));
      expect(sent, contains('${order.number}'));
      expect(sent, contains('Cheeseburger Meal'));
      expect(sent, contains('Paid by card'));
      expect(sent, contains('The Vesopa Kitchen'));
      // ignore: avoid_print
      print('TICKET ${sent.length} bytes, number ${order.number}');
    }
  });
}
