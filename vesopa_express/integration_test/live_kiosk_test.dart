// A real order, from the real app, on the real server, paid on the Dojo
// sandbox card machine.
//
// Unit tests on this platform have passed while the feature was broken, twice,
// so the kiosk is also driven end to end against production -- the TEST venue
// only -- with a kiosk token minted on the server:
//
//   ssh:  node tool/verify-express-live.js --hold      (prints nothing secret;
//                                                       writes tmp/express-kiosk-token.txt)
//   here: flutter test integration_test/live_kiosk_test.dart -d windows ^
//           --dart-define=EXPRESS_TOKEN=<that token> --dart-define=EXPRESS_WINDOWED=true ^
//           --dart-define=EXPRESS_W=540 --dart-define=EXPRESS_H=960 ^
//           --dart-define=EXPRESS_SHOTS=<folder>
//   ssh:  node tool/verify-express-live.js --release   (removes every row it made)
//
// Each step is photographed into EXPRESS_SHOTS, because several faults here
// were only ever visible in a screenshot.

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

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final frame = GlobalKey();

  Future<void> shot(WidgetTester tester, String name) async {
    if (_shots.isEmpty) return;
    await tester.pump(const Duration(milliseconds: 300));
    await tester.runAsync(() async {
      final boundary = frame.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1.5);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      final file = File('$_shots/$name.png');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(png!.buffer.asUint8List());
    });
  }

  /// Keep drawing frames, with real time passing, until [finder] finds
  /// something -- the server and the card machine answer when they answer.
  Future<void> waitFor(WidgetTester tester, Finder finder, {int seconds = 30}) async {
    final end = DateTime.now().add(Duration(seconds: seconds));
    while (DateTime.now().isBefore(end)) {
      await tester.pump(const Duration(milliseconds: 200));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      if (finder.evaluate().isNotEmpty) return;
    }
    throw TestFailure('Timed out waiting for $finder');
  }

  testWidgets('a real order, paid on the Dojo sandbox machine', (tester) async {
    expect(ExpressConfig.seedToken, isNotEmpty, reason: 'pass --dart-define=EXPRESS_TOKEN');
    SharedPreferences.setMockInitialValues({});
    await KioskWindow.lock();

    await tester.pumpWidget(
      RepaintBoundary(key: frame, child: const ProviderScope(child: ExpressApp())),
    );

    await waitFor(tester, find.text('Touch to start'));
    await shot(tester, 'live_01_attract');

    await tester.tap(find.text('Touch to start'));
    await waitFor(tester, find.text('Take away'));
    await shot(tester, 'live_02_order_type');

    await tester.tap(find.text('Take away'));
    await waitFor(tester, find.byType(ItemCard));
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 2))); // pictures
    await shot(tester, 'live_03_menu');

    // The first dish that is not sold out.
    final cards = find.byType(ItemCard);
    await tester.tap(cards.first);
    await waitFor(tester, find.textContaining('Add to order'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 1)));
    await shot(tester, 'live_04_dish');
    await tester.tap(find.textContaining('Add to order'));
    await waitFor(tester, find.text('Review order'));
    await tester.pump(const Duration(milliseconds: 600));

    final element = tester.element(find.byType(ExpressApp));
    final container = ProviderScope.containerOf(element);
    expect(container.read(orderFlowProvider).basket.count, 1);

    await tester.tap(find.text('Review order').last);
    await waitFor(tester, find.textContaining('Pay now'));
    await shot(tester, 'live_05_basket');
    await tester.tap(find.textContaining('Pay now'));

    // The test venue asks for a name while held.
    await waitFor(tester, find.textContaining('What name'), seconds: 10);
    for (final l in ['T', 'E', 'S', 'T']) {
      await tester.tap(find.text(l));
      await tester.pump(const Duration(milliseconds: 80));
    }
    await shot(tester, 'live_06_name');
    await tester.tap(find.text('Continue'));

    await waitFor(tester, find.text('Pay by card here'));
    await shot(tester, 'live_07_pay_method');
    await tester.tap(find.text('Pay by card here'));

    await waitFor(tester, find.textContaining('your card'), seconds: 40);
    await shot(tester, 'live_08_paying');

    // The sandbox machine approves by itself; a real one waits for a card.
    await waitFor(tester, find.text('Thank you!'), seconds: 150);
    await shot(tester, 'live_09_done');

    final order = container.read(orderFlowProvider).order!;
    expect(order.number, greaterThan(0));
    // ignore: avoid_print
    print('LIVE ORDER ${order.number} paid, ${order.totalMinor}p');
  });
}
