// ignore_for_file: invalid_use_of_visible_for_testing_member, invalid_use_of_protected_member
// The sale screen on an iPhone turned on its side (owner, 2026-11-26: "fix
// iphone landscape pages not the portrait"): the demo venue rung up at an
// iPhone SE, 15 and 15 Pro Max's own sizes, every overflow a failure, and a
// picture of each.
//
//   SHOTS_FONTS=<folder with Roboto-*.ttf> flutter test store_shots/iphone_sale_test.dart
//
// Writes store_shots/out/iphone-*.png.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/counter/data/journal.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/main.dart';

Future<void> _loadFonts() async {
  final dir = Platform.environment['SHOTS_FONTS'];
  if (dir == null || !Directory(dir).existsSync()) {
    throw StateError('Set SHOTS_FONTS to a folder with Roboto-*.ttf (apt: fonts-roboto-unhinted)');
  }
  final roboto = FontLoader('Roboto');
  final files = Directory(dir)
      .listSync(recursive: true)
      .whereType<File>()
      .where((f) => RegExp(r'/Roboto-(Thin|Light|Regular|Medium|Bold|Black)\.ttf$').hasMatch(f.path))
      .toList();
  if (files.isEmpty) throw StateError('No Roboto-*.ttf under $dir');
  // Text that names no family (a button's own style) is drawn in the
  // device's: Roboto on a TV, the block test font in a test. Roboto under
  // the test font's name too, so it is Roboto here as well.
  final fallbacks = [
    for (final f in ['Ahem', 'FlutterTest', 'CupertinoSystemText', 'CupertinoSystemDisplay', '.SF UI Text', '.SF UI Display', '.SF Pro Text', '.AppleSystemUIFont']) FontLoader(f),
  ];
  for (final f in files) {
    final bytes = ByteData.sublistView(f.readAsBytesSync());
    roboto.addFont(Future.value(bytes));
    for (final l in fallbacks) {
      l.addFont(Future.value(bytes));
    }
  }
  await roboto.load();
  for (final l in fallbacks) {
    await l.load();
  }
  final sdk = Platform.environment['FLUTTER_ROOT'] ?? '';
  final icons = File('$sdk/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
  if (icons.existsSync()) {
    await (FontLoader('MaterialIcons')..addFont(Future.value(ByteData.sublistView(icons.readAsBytesSync())))).load();
  }
}


Future<void> _save(WidgetTester tester, String name) async {
  debugDisableShadows = false;
  try {
    await tester.pump();
    final boundary = tester.renderObject<RenderRepaintBoundary>(find.byType(RepaintBoundary).first);
    await tester.runAsync(() async {
      final image = await boundary.toImage(pixelRatio: tester.view.devicePixelRatio);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      File('store_shots/out/$name.png')
        ..createSync(recursive: true)
        ..writeAsBytesSync(png!.buffer.asUint8List());
    });
  } finally {
    debugDisableShadows = true;
  }
}


/// The Vesopa Kitchen's till screens as the back office sends them (the
/// owner's iPad, 2026-11-26): Clock in / Sign On / Sign off across the top,
/// six by six keys with the page keys down the right, and Void to Pay along
/// the bottom.
Map<String, dynamic> _kitchenConfig() {
  const plus = [122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 139, 140, 141, 142, 143, 144, 146, 147, 148, 150, 151, 152, 153];
  final buttons = <Map<String, dynamic>>[];
  var i = 0;
  for (var r = 0; r < 6; r++) {
    for (var c = 0; c < 5; c++) {
      if (i < plus.length) buttons.add({'row': r, 'col': c, 'kind': 'product', 'pluId': plus[i++]});
    }
  }
  const pages = ['FOOD', 'BAR', 'SOFT & HOT', 'MIXERS', 'COVERS'];
  for (var r = 0; r < pages.length; r++) {
    buttons.add({'row': r, 'col': 5, 'kind': 'page', 'targetScreenId': 2, 'label': pages[r]});
  }
  const bottom = ['void', 'cancel', 'save_table', 'covers', 'customer', 'note', 'open_drawer', 'last_bill', 'table_plan', 'pay'];
  const top = ['clock_in_out', 'sign_on', 'sign_off'];
  return {
    'screens': [
      {'id': 1, 'name': 'VesopaTest1', 'surface': 'sale', 'rows': 6, 'cols': 6, 'buttons': buttons},
      {'id': 2, 'name': 'Food', 'surface': 'sale', 'rows': 1, 'cols': 1, 'buttons': []},
      {
        'id': 90, 'name': 'Bottom', 'surface': 'bottombar', 'rows': 1, 'cols': bottom.length,
        'buttons': [for (var c = 0; c < bottom.length; c++) {'row': 0, 'col': c, 'kind': 'function', 'functionKey': bottom[c]}],
      },
      {
        'id': 91, 'name': 'Top', 'surface': 'topbar', 'rows': 1, 'cols': top.length,
        'buttons': [for (var c = 0; c < top.length; c++) {'row': 0, 'col': c, 'kind': 'function', 'functionKey': top[c]}],
      },
    ],
    'till': {'home_screen_id': 1, 'top_bar_screen_id': 91, 'bottom_bar_screen_id': 90},
    'go': {'screens_phone': 'till', 'screens_tablet': 'till'},
  };
}

void main() {
  setUpAll(() async {
    await _loadFonts();

    final binding = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    for (final ch in ['xyz.luan/audioplayers', 'xyz.luan/audioplayers.global', 'com.llfbandit.app_links/messages', 'com.llfbandit.app_links/events']) {
      binding.setMockMethodCallHandler(MethodChannel(ch), (_) async => null);
    }
  });

  // iPhone SE (3rd), iPhone 15, iPhone 15 Pro Max: pixels and density.
  for (final (name, size, dpr) in [
    ('se', const Size(1334, 750), 2.0),
    ('15', const Size(2556, 1179), 3.0),
    ('15-pro-max', const Size(2796, 1290), 3.0),
  ]) {
    testWidgets('iPhone $name on its side: the sale page fits', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = dpr;
      // On its side: the notch at one end, the home bar along the bottom.
      final notch = name == 'se' ? 0.0 : 59 * dpr;
      tester.view.padding = FakeViewPadding(left: notch, right: notch, bottom: 21 * dpr);
      tester.view.viewPadding = FakeViewPadding(left: notch, right: notch, bottom: 21 * dpr);
      addTearDown(tester.view.reset);
      // No sound or deep-link plugins in a test: their errors are not the layout's.
      final previous = FlutterError.onError;
      FlutterError.onError = (d) => d.exception is MissingPluginException ? null : previous?.call(d);
      addTearDown(() => FlutterError.onError = previous);
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      FlutterSecureStorage.setMockInitialValues({});
      SharedPreferences.setMockInitialValues({'go_accent_asked': true});
      Journal.persist = false;

      Future<void> tap(Finder f) async {
        await tester.ensureVisible(f.first);
        await tester.pumpAndSettle();
        await tester.tap(f.first);
        await tester.pumpAndSettle();
      }

      await tester.pumpWidget(const ProviderScope(child: GoApp()));
      await tester.pumpAndSettle();
      await _save(tester, 'iphone-$name-0-start');
      await tap(find.byKey(const ValueKey('demo')));
      await _save(tester, 'iphone-$name-0-pin');
      for (final d in ['1', '1', '1', '1']) {
        await tester.tap(find.byKey(ValueKey('pin-$d')));
        await tester.pump();
      }
      await tester.pumpAndSettle();
      await _save(tester, 'iphone-$name-1-sell');
      await tap(find.byKey(const ValueKey('item-p147')));
      if (find.text('Buffalo').evaluate().isNotEmpty) {
        await tap(find.text('Buffalo'));
        await tap(find.byKey(const ValueKey('add')));
      }
      await tap(find.text('Mains'));
      await tap(find.textContaining('Steak'));
      if (find.text('Medium').evaluate().isNotEmpty) {
        await tap(find.text('Medium'));
        await tap(find.byKey(const ValueKey('add')));
      }
      await _save(tester, 'iphone-$name-2-rung');
      if (find.byKey(const ValueKey('view-sale')).evaluate().isNotEmpty) {
        await tap(find.byKey(const ValueKey('view-sale')));
        await _save(tester, 'iphone-$name-3-sale');
        if (find.byType(BackButton).evaluate().isNotEmpty) {
          await tester.pageBack();
          await tester.pumpAndSettle();
        }
      }
      // A table's order, the other sale page: the header first, folded away.
      if (find.byTooltip('Open navigation menu').evaluate().isEmpty) {
        await tap(find.byIcon(Icons.keyboard_arrow_down_rounded));
      }
      await tap(find.byTooltip('Open navigation menu'));
      await tap(find.text('Tables').last);
      await tap(find.text('Table 1'));
      if (find.text('2').evaluate().isNotEmpty) await tap(find.text('2').first);
      await _save(tester, 'iphone-$name-4-table');
      await tap(find.text('Chicken Wings'));
      if (find.text('Buffalo').evaluate().isNotEmpty) {
        await tap(find.text('Buffalo'));
        await tap(find.byKey(const ValueKey('add')));
      }
      await _save(tester, 'iphone-$name-5-table-rung');
      debugDefaultTargetPlatformOverride = null;
    });

    testWidgets('iPhone $name on its side: The Vesopa Kitchen\'s till screens', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = dpr;
      final notch = name == 'se' ? 0.0 : 59 * dpr;
      tester.view.padding = FakeViewPadding(left: notch, right: notch, bottom: 21 * dpr);
      tester.view.viewPadding = FakeViewPadding(left: notch, right: notch, bottom: 21 * dpr);
      addTearDown(tester.view.reset);
      // No sound or deep-link plugins in a test: their errors are not the layout's.
      final previous = FlutterError.onError;
      FlutterError.onError = (d) => d.exception is MissingPluginException ? null : previous?.call(d);
      addTearDown(() => FlutterError.onError = previous);
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      FlutterSecureStorage.setMockInitialValues({});
      SharedPreferences.setMockInitialValues({'go_accent_asked': true});
      Journal.persist = false;

      await tester.pumpWidget(const ProviderScope(child: GoApp()));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const ValueKey('demo')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('demo')));
      await tester.pumpAndSettle();
      for (final d in ['1', '1', '1', '1']) {
        await tester.tap(find.byKey(ValueKey('pin-$d')));
        await tester.pump();
      }
      await tester.pumpAndSettle();
      final container = ProviderScope.containerOf(tester.element(find.byType(Scaffold).first));
      final session = container.read(tapProvider.notifier);
      session.state = session.state.copyWith(config: TapConfig.fromJson(_kitchenConfig()));
      await tester.pumpAndSettle();
      await _save(tester, 'iphone-$name-6-kitchen');
      await tester.tap(find.text('Carling Half').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('IPA Pint').first, warnIfMissed: false);
      await tester.pumpAndSettle();
      if (find.byKey(const ValueKey('add')).evaluate().isNotEmpty) {
        await tester.tap(find.byKey(const ValueKey('add')));
        await tester.pumpAndSettle();
      }
      await _save(tester, 'iphone-$name-7-kitchen-rung');
      // The notice goes; then the top keys and the bottom keys, each tucked
      // behind a tab at the right, slide out and back. Pay stays in the sale.
      await tester.pump(const Duration(seconds: 4));
      await tester.pumpAndSettle();
      await _save(tester, 'iphone-$name-7b-kitchen-folded');
      final semantics = tester.ensureSemantics();
      expect(find.byKey(const ValueKey('floating-pay')), findsOneWidget);
      await tester.tap(find.byIcon(Icons.chevron_left_rounded).last);
      await tester.pumpAndSettle();
      await _save(tester, 'iphone-$name-8-kitchen-top-open');
      expect(find.text('Sign off'), findsOneWidget);
      await tester.tap(find.byIcon(Icons.chevron_right_rounded));
      await tester.pumpAndSettle();
      expect(find.text('Sign off'), findsNothing);
      await tester.tap(find.byIcon(Icons.chevron_left_rounded).first);
      await tester.pumpAndSettle();
      await _save(tester, 'iphone-$name-9-kitchen-bottom-open');
      expect(find.bySemanticsLabel('Table Plan'), findsOneWidget);
      await tester.tap(find.byIcon(Icons.chevron_right_rounded));
      await tester.pumpAndSettle();
      expect(find.bySemanticsLabel('Table Plan'), findsNothing);
      // The header, folded to a tab at the top, comes back and folds again.
      expect(find.text('Sam'), findsNothing);
      await tester.tap(find.byIcon(Icons.keyboard_arrow_down_rounded));
      await tester.pumpAndSettle();
      expect(find.text('Sam'), findsOneWidget);
      await _save(tester, 'iphone-$name-10-kitchen-header-open');
      await tester.tap(find.byTooltip('Hide the header'));
      await tester.pumpAndSettle();
      expect(find.text('Sam'), findsNothing);
      semantics.dispose();
      debugDefaultTargetPlatformOverride = null;
    });
  }
}
