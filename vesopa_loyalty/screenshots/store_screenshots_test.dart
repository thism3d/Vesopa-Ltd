// The App Store screenshots, from the app itself.
//
// Not a test of anything: it runs the real pages (card, activity, news,
// venue, sign-in) against a made-up member and saves each one at the sizes the
// App Store takes, so the pictures are the app as it is rather than a mock-up
// that drifts from it. Nothing is fetched; every answer the server would give
// is below.
//
// Run in a venue's project by tool/make_store_screenshots.py, which then
// frames the raw pictures with their captions:
//
//   python vesopa_loyalty/tool/make_store_screenshots.py PontardaweRFC
//
// Raw pictures go to $SCREENSHOT_OUT (build/screenshots/raw by default) as
// <device>-<n>-<name>.png.

import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_loyalty/main.dart';

const _base = 'https://loyalty.vesopa.com';

final _out = Platform.environment['SCREENSHOT_OUT'] ?? 'build/screenshots/raw';
final _venue = jsonDecode(File('screenshots/venue.json').readAsStringSync()) as Map<String, dynamic>;
final _slug = _venue['slug'] as String;
final _logoUrl = '$_base/uploads/app/$_slug-crest.png';

/// The devices, as App Store Connect sizes them: logical size and pixel ratio.
const _devices = {
  'iphone-6.9': (Size(430, 932), 3.0),
  'ipad-13': (Size(1024, 1366), 2.0),
};

DateTime _daysAgo(int d, [int hour = 19]) {
  final now = DateTime.now();
  return DateTime(now.year, now.month, now.day, hour).subtract(Duration(days: d));
}

String _iso(DateTime d) => d.toUtc().toIso8601String();

Map<String, dynamic> _brand() {
  final c = (_venue['colours'] as Map).cast<String, dynamic>();
  return {
    'slug': _slug,
    'name': _venue['name'],
    'venue': _venue['name'],
    'welcome': 'Welcome to the club. Your card, your discount and all the club news, in one place.',
    'logo': _logoUrl,
    'colours': {
      'primary': c['background'],
      'accent': c['glow'],
      'background': '#FFFFFF',
      'text': '#1B1414',
      'icon': c['background'],
    },
    'fonts': {'heading': null, 'body': null},
    'links': <String, String>{},
    'points': {'value_minor': 1, 'min_redeem': 500},
    'inbox': {'mode': 'limit', 'limit': 12},
    'signin': {'methods': ['code_email', 'password'], 'policy': 'code_first', 'self_service': false},
    'members_only': true,
    'push': {'web': null, 'windows': false},
  };
}

const _points = 342;

Map<String, dynamic> _me() => {
  'name': 'Rhys Morgan',
  'email': 'rhys@example.com',
  'photo_url': null,
  'membership': {
    'expiry': _iso(DateTime(DateTime.now().year + 1, 6, 30)),
    'expired': false,
    'term_months': 12,
    'fee_minor': 0,
    'renewal_date': null,
  },
  'card_number': '999800147',
  'member_no': 147,
  'member_number': '00147',
  'scheme': {'name': 'Full member', 'colour': '#FFFFFF', 'summary': 'Members\' prices on every visit'},
  'qr': '999800147',
  'points': _points,
  'points_value_minor': _points,
  'tier': null,
  'visits': 38,
  'last_visit': _iso(_daysAgo(2)),
  'membership_expiry': _iso(DateTime(DateTime.now().year + 1, 6, 30)),
  'member_since': _iso(DateTime(DateTime.now().year - 3, 8, 14)),
};

Map<String, dynamic> _history() {
  // A pound a point at the bar, newest first, and one reward taken.
  var balance = _points;
  var id = 900;
  final items = <Map<String, dynamic>>[];
  void add(int daysAgo, String kind, int points, {int spend = 0, int value = 0, String note = 'Clubhouse bar'}) {
    items.add({
      'id': id++,
      'kind': kind,
      'points': points,
      'balance_after': balance,
      'spend_minor': spend,
      'value_minor': value,
      'note': note,
      'created_at': _iso(_daysAgo(daysAgo, 17)),
    });
    balance -= points;
  }

  add(2, 'earn', 23, spend: 2340);
  add(6, 'earn', 11, spend: 1180);
  add(9, 'redeem', -500, value: 500);
  add(9, 'earn', 36, spend: 3650);
  add(13, 'earn', 8, spend: 860);
  add(16, 'earn', 27, spend: 2790);
  add(20, 'earn', 14, spend: 1420);
  add(23, 'earn', 41, spend: 4110);
  add(27, 'earn', 9, spend: 990);
  return {'items': items, 'more': false};
}

Map<String, dynamic> _messages() {
  Map<String, dynamic> m(int id, int daysAgo, String title, String body, {bool read = true}) => {
    'id': id,
    'title': title,
    'body': body,
    'image_url': null,
    'link_url': null,
    'video_url': null,
    'video_embed_url': null,
    'sent_at': _iso(_daysAgo(daysAgo, 12)),
    'shown_at': _iso(_daysAgo(daysAgo, 12)),
    'read_at': read ? _iso(_daysAgo(daysAgo, 13)) : null,
  };
  return {
    'items': [
      m(5, 0, 'Home game on Saturday', 'Kick-off 2:30pm. The bar opens at noon and food is served from 12:30. Come and support the boys!', read: false),
      m(4, 1, 'International on the big screen', 'Every match shown in the clubhouse. Members\' prices all day.', read: false),
      m(3, 4, 'Quiz night, Thursday 8pm', 'Teams of up to six. £1 a head, all for the junior section.'),
      m(2, 8, 'Membership renewals', 'Renew at the bar before the end of the month and keep your members\' discount.'),
      m(1, 12, 'Clubhouse opening times', 'Open from 5pm on weekdays and all day at weekends.'),
    ],
    'unread': 2,
    'more': false,
    'mode': 'limit',
    'limit': 12,
  };
}

Map<String, dynamic> _account() => {
  'name': 'Rhys Morgan',
  'email': 'rhys@example.com',
  'phone': null,
  'has_password': true,
  'passkeys': <Object>[],
  'sessions': 1,
};

http.Client _server() => MockClient((req) async {
  final p = req.url.path;
  Object? body;
  if (p == '/loyalty/v1/app/$_slug') {
    body = _brand();
  } else if (p == '/loyalty/v1/me') {
    body = _me();
  } else if (p == '/loyalty/v1/me/history') {
    body = _history();
  } else if (p == '/loyalty/v1/me/messages') {
    body = _messages();
  } else if (p == '/loyalty/v1/me/account') {
    body = _account();
  } else if (p == '/loyalty/v1/me/membership') {
    return http.Response('{"error":"none"}', 404);
  } else if (p == '/loyalty/v1/me/classes') {
    body = <Object>[];
  } else if (p.startsWith('/loyalty/v1/me/')) {
    body = {'ok': true};
  } else if (p.contains('app-update')) {
    body = {'update': null};
  } else {
    return http.Response('{"error":"not here"}', 404);
  }
  return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
});

Future<void> _fonts() async {
  final sdk = Platform.environment['FLUTTER_ROOT'] ?? '';
  final material = '$sdk/bin/cache/artifacts/material_fonts';
  Future<void> load(String family, List<String> files) async {
    final loader = FontLoader(family);
    for (final f in files) {
      loader.addFont(Future.value(ByteData.sublistView(File(f).readAsBytesSync())));
    }
    await loader.load();
  }

  final roboto = [
    for (final w in ['Regular', 'Medium', 'Bold', 'Black', 'Light']) '$material/Roboto-$w.ttf',
  ];
  // An iPhone's own text is San Francisco, which may not be shipped; Roboto
  // stands in for it under the names Flutter asks for on iOS.
  for (final family in ['Roboto', 'CupertinoSystemText', 'CupertinoSystemDisplay', '.SF UI Text', '.SF UI Display', '.SF Pro Text']) {
    await load(family, roboto);
  }
  await load('MaterialIcons', ['$material/MaterialIcons-Regular.otf']);
}

/// The phone's own channels, answered as an iPhone with notifications on.
void _platform() {
  final m = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  Future<Object?> answer(MethodCall call) async => switch (call.method) {
    'token' => {'kind': 'apns', 'token': 'ab' * 32},
    'available' => false,
    'opened' => null,
    _ => null,
  };
  for (final name in [
    'vesopa_loyalty/push',
    'vesopa_loyalty/wallet',
    'vesopa_loyalty/watch',
    'vesopa_loyalty/wns',
    'vesopa/store_update',
    'github.com/aaassseee/screen_brightness',
    'flutter.baseflow.com/geolocator',
    'flutter.baseflow.com/geolocator_apple',
  ]) {
    m.setMockMethodCallHandler(MethodChannel(name), answer);
  }
}

/// The crest, put where the network image would have put it.
Future<void> _crest(WidgetTester tester) async {
  final bytes = File('assets/venue/crest.png').readAsBytesSync();
  final image = await tester.runAsync(() async {
    final codec = await ui.instantiateImageCodec(bytes);
    return (await codec.getNextFrame()).image;
  });
  final completer = OneFrameImageStreamCompleter(Future.value(ImageInfo(image: image!)));
  PaintingBinding.instance.imageCache.putIfAbsent(NetworkImage(_logoUrl), () => completer);
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 60)));
    await tester.pump(const Duration(milliseconds: 400));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 5));
}

Future<void> _save(WidgetTester tester, GlobalKey key, String device, double ratio, String name) async {
  final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: ratio);
    final png = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('$_out/$device-$name.png')..createSync(recursive: true);
    file.writeAsBytesSync(png!.buffer.asUint8List());
  });
  // ignore: avoid_print
  print('saved $device-$name');
}

void main() {
  setUpAll(() async {
    await _fonts();
  });

  for (final MapEntry(key: device, value: (size, ratio)) in _devices.entries) {
    testWidgets('store screenshots, $device', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      _platform();
      tester.view
        ..physicalSize = size * ratio
        ..devicePixelRatio = ratio
        ..padding = FakeViewPadding(top: 59 * ratio, bottom: 34 * ratio)
        ..viewPadding = FakeViewPadding(top: 59 * ratio, bottom: 34 * ratio);
      addTearDown(tester.view.reset);
      await _crest(tester);

      Future<void> run(Future<void> Function(GlobalKey shot) body, {bool signedIn = true}) async {
        // Outside test/, so the analyzer does not know this is a test.
        // ignore: invalid_use_of_visible_for_testing_member
        SharedPreferences.setMockInitialValues({
          'loyalty_venue_slug': _slug,
          if (signedIn) 'loyalty_token_$_slug': 'store-screenshots',
          'push_on_$_slug': true,
        });
        final shot = GlobalKey();
        await http.runWithClient(() async {
          await tester.pumpWidget(
            RepaintBoundary(key: shot, child: const ProviderScope(child: LoyaltyApp())),
          );
          await _settle(tester);
          await body(shot);
        }, _server);
        await tester.pumpWidget(const SizedBox());
        await tester.pump();
      }

      await run((shot) async {
        await _save(tester, shot, device, ratio, '1-card');
        // Activity.
        await tester.tap(find.text('Activity').last);
        await _settle(tester);
        await _save(tester, shot, device, ratio, '2-activity');
        // The venue page, with notifications.
        await tester.tap(find.text('Venue').last);
        await _settle(tester);
        await _save(tester, shot, device, ratio, '4-venue');
        // News, from the bell.
        await tester.tap(find.text('Card').last);
        await _settle(tester);
        await tester.tap(find.byIcon(Icons.notifications_active));
        await _settle(tester);
        await _save(tester, shot, device, ratio, '3-news');
      });

      await run((shot) async {
        await _save(tester, shot, device, ratio, '5-sign-in');
      }, signedIn: false);

      debugDefaultTargetPlatformOverride = null;
    });
  }
}
