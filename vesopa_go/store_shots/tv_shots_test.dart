// Google Play's Android TV screenshots for Vesopa Go: the app's own TV
// screens, drawn by Flutter at 1920x1080 (a 1080p television at xhdpi, 960x540
// points), with the Roboto a TV draws in and the app's own icons.
//
//   TV_SHOTS_FONTS=/usr/share/fonts/truetype/roboto \
//     flutter test --update-goldens store_shots/tv_shots_test.dart
//
// Writes store_shots/out/NN-name.png. Kept out of test/ so the ordinary test
// run never compares against these. Run by .github/workflows/go-tv-shots.yml,
// which puts them in store/screenshots/android-tv for play.json's
// tvScreenshots.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/display/data/basket_feed.dart';
import 'package:vesopa_go/display/ui/display_mode_page.dart';
import 'package:vesopa_go/kitchen/data/dinein_inbox.dart';
import 'package:vesopa_go/kitchen/data/kitchen_session.dart';
import 'package:vesopa_go/kitchen/data/providers.dart';
import 'package:vesopa_go/kitchen/data/screen_profile.dart';
import 'package:vesopa_go/kitchen/data/ticket.dart';
import 'package:vesopa_go/kitchen/data/ticket_board.dart';
import 'package:vesopa_go/kitchen/ui/kitchen_mode_page.dart';
import 'package:vesopa_go/ui/pages/link_screen_page.dart';
import 'package:vesopa_go/ui/theme.dart';
import 'package:vesopa_go/ui/tv.dart';

const _shot = ValueKey('tv-shot');

/// Roboto (every .ttf under TV_SHOTS_FONTS named Roboto-<weight>.ttf) and the
/// Material icons from the Flutter SDK; without them a test draws boxes.
Future<void> _loadFonts() async {
  final dir = Platform.environment['TV_SHOTS_FONTS'];
  if (dir == null || !Directory(dir).existsSync()) {
    throw StateError('Set TV_SHOTS_FONTS to a folder with Roboto-*.ttf (apt: fonts-roboto-unhinted)');
  }
  final roboto = FontLoader('Roboto');
  final files = Directory(dir)
      .listSync(recursive: true)
      .whereType<File>()
      .where((f) => RegExp(r'/Roboto-(Thin|Light|Regular|Medium|Bold|Black)\.ttf$').hasMatch(f.path))
      .toList();
  if (files.isEmpty) throw StateError('No Roboto-*.ttf under $dir');
  for (final f in files) {
    roboto.addFont(Future.value(ByteData.sublistView(f.readAsBytesSync())));
  }
  await roboto.load();
  final sdk = Platform.environment['FLUTTER_ROOT'] ?? '';
  final icons = File('$sdk/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
  if (icons.existsSync()) {
    await (FontLoader('MaterialIcons')..addFont(Future.value(ByteData.sublistView(icons.readAsBytesSync())))).load();
  }
}

/// A 1080p TV: 1920x1080 pixels at density 2.
Future<void> _tv(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1920, 1080);
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  GoDevice.debugTv = true;
  addTearDown(() => GoDevice.debugTv = false);
  SharedPreferences.setMockInitialValues({});
}

Widget _app(Widget home, {List<Override> overrides = const []}) => RepaintBoundary(
      key: _shot,
      child: ProviderScope(
        overrides: overrides,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: tvFocusTheme(Tp.theme(Brightness.dark)),
          home: home,
        ),
      ),
    );

/// Let animations finish (a page may keep a clock ticking, so no settle).
Future<void> _still(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 250));
  }
}

Future<void> _save(WidgetTester tester, String name) async {
  debugDisableShadows = false;
  try {
    await tester.pump();
    await expectLater(find.byKey(_shot), matchesGoldenFile('out/$name.png'));
  } finally {
    debugDisableShadows = true;
  }
  // Close the page so its timers stop before the test ends.
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 1));
}

/// The app's session without its start-up (secure storage, the venue).
class _Tap extends TapSession {
  @override
  TapState build() => const TapState(phase: Phase.booting);
}

// ---- the kitchen board ------------------------------------------------------

Map<String, Object?> _line(String id, String name, {double qty = 1, String? note, bool mod = false, List<String> allergens = const []}) => {
      'id': id,
      'seq': int.parse(id.replaceAll(RegExp('[^0-9]'), '')),
      'quantity': qty,
      'name': name,
      'note': ?note,
      'isModifier': mod,
      'allergens': allergens,
      'stations': ['kp1'],
    };

Ticket _ticket(String id, {int? table, int covers = 2, required String staff, required int minutes, String? note, bool rushed = false, required List<Map<String, Object?>> lines}) =>
    Ticket.fromJson({
      'id': id,
      'kind': table == null ? 'sale' : 'table',
      'ticketNo': id,
      'tableNumber': ?table,
      'covers': table == null ? null : covers,
      'staffName': staff,
      'note': ?note,
      'rushed': rushed,
      'placedAt': DateTime.now().subtract(Duration(minutes: minutes)).toIso8601String(),
      'lines': lines,
      'stations': [
        {'station': 'kp1', 'status': 'open'},
      ],
    });

final _tickets = [
  _ticket('T12', table: 12, covers: 4, staff: 'Megan', minutes: 14, rushed: true, lines: [
    _line('a1', 'Welsh beef burger', qty: 2),
    _line('a2', 'Medium', mod: true),
    _line('a3', 'Extra cheddar', mod: true),
    _line('a4', 'Fish and chips', note: 'Mushy peas on the side', allergens: ['Fish', 'Gluten']),
    _line('a5', 'Halloumi salad', allergens: ['Milk']),
  ]),
  _ticket('T4', table: 4, covers: 2, staff: 'Rhys', minutes: 9, lines: [
    _line('b1', 'Steak and ale pie'),
    _line('b2', 'Mash', mod: true),
    _line('b3', 'Chicken Caesar', allergens: ['Egg', 'Milk', 'Fish']),
  ]),
  _ticket('1043', staff: 'Counter', minutes: 6, lines: [
    _line('c1', 'Loaded fries', qty: 2),
    _line('c2', 'Chicken wings', qty: 6, note: 'Hot sauce'),
  ]),
  _ticket('T7', table: 7, covers: 3, staff: 'Megan', minutes: 4, note: 'Birthday: candle on the brownie', lines: [
    _line('d1', 'Chocolate brownie', allergens: ['Gluten', 'Milk', 'Egg']),
    _line('d2', 'Sticky toffee pudding', qty: 2),
    _line('d3', 'Custard', mod: true),
  ]),
  _ticket('T9', table: 9, covers: 2, staff: 'Rhys', minutes: 2, lines: [
    _line('e1', 'Garlic bread', allergens: ['Gluten', 'Milk']),
    _line('e2', 'Margherita pizza'),
  ]),
  _ticket('1044', staff: 'Counter', minutes: 1, lines: [
    _line('f1', 'Bacon bap', qty: 2),
    _line('f2', 'Cheese toastie', allergens: ['Gluten', 'Milk']),
  ]),
];

class _Board extends TicketBoard {
  @override
  BoardState build() => BoardState(tickets: _tickets, online: true);
  @override
  Future<void> start(String office, String wsUrl) async {}
}

class _Inbox extends DineInInbox {
  @override
  void start() {}
}

class _Session extends KitchenSessionController {
  @override
  Future<KitchenSession> build() async => KitchenSession(
        token: 't',
        office: 'kitchen@example.com',
        officeName: 'The Vesopa Kitchen',
        screenId: 5,
        screens: [ScreenProfile.fromJson({'id': 5, 'name': 'Main kitchen', 'sites': <int>[]})],
      );
}

// ---- the customer display ---------------------------------------------------

final _basket = Basket(
  state: 'sale',
  updatedAt: DateTime.now(),
  customerName: 'Ceri',
  customerPoints: 240,
  lines: const [
    BasketLine(name: 'Guinness', quantity: 2, totalMinor: 1100),
    BasketLine(name: 'Gin and tonic', quantity: 1, totalMinor: 850),
    BasketLine(name: 'Slimline tonic', quantity: 1, totalMinor: 0, isModifier: true),
    BasketLine(name: 'Welsh beef burger', quantity: 1, totalMinor: 1595),
    BasketLine(name: 'Fish and chips', quantity: 1, totalMinor: 1495, allergens: ['Fish', 'Gluten']),
    BasketLine(name: 'Sticky toffee pudding', quantity: 2, totalMinor: 1300, allergens: ['Gluten', 'Milk', 'Egg']),
  ],
  subtotalMinor: 6340,
  discountMinor: 634,
  totalMinor: 5706,
);

void main() {
  setUpAll(_loadFonts);

  testWidgets('01 connect: a new TV shows a code to scan, nothing to type', (tester) async {
    await _tv(tester);
    final api = TapApi(client: MockClient((req) async {
      final body = req.url.path.endsWith('/start')
          ? {'code': 'K7QM4P2D', 'secret': 's', 'url': 'https://go.vesopa.com/link?c=K7QM4P2D', 'expires_in': 600}
          : {'status': 'waiting'};
      return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
    }));
    await tester.pumpWidget(_app(const LinkScreenPage(), overrides: [apiProvider.overrideWithValue(api), tapProvider.overrideWith(_Tap.new)]));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
    await _still(tester);
    await _save(tester, '01-connect');
  });

  testWidgets('02 kitchen: the kitchen board, every ticket at a glance', (tester) async {
    await _tv(tester);
    await tester.pumpWidget(_app(const KitchenModePage(), overrides: [
      ticketBoardProvider.overrideWith(_Board.new),
      dineInInboxProvider.overrideWith(_Inbox.new),
      kitchenSessionProvider.overrideWith(_Session.new),
      allergenLabelsProvider.overrideWith((_) async => const {}),
    ]));
    await _still(tester);
    await _save(tester, '02-kitchen');
  });

  testWidgets('03 display: the customer sees their bill as it is rung up', (tester) async {
    await _tv(tester);
    await tester.pumpWidget(_app(displayPreview(basket: _basket, venue: 'The Vesopa Kitchen')));
    await _still(tester);
    await _save(tester, '03-customer-display');
  });

  testWidgets('04 display: a display waiting for its till', (tester) async {
    await _tv(tester);
    await tester.pumpWidget(_app(displayPreview(venue: 'The Vesopa Kitchen')));
    await _still(tester);
    await _save(tester, '04-display-code');
  });

}
