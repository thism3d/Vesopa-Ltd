// Renders the sign-up's pages to PNGs for a look (not a golden): run with
// SHOTS=dir flutter test test/onboarding_look_test.dart
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/pages/onboarding.dart';
import 'package:vesopa_go/ui/theme.dart';

class _FakeApi extends TapApi {
  _FakeApi(this.status);
  final Map<String, dynamic> status;
  @override
  Future<Map<String, dynamic>> onboardingStatus({bool refresh = false}) async => status;
}

Map<String, dynamic> _status({String next = 'stripe', bool business = true, String identity = 'not_started', String stripe = 'in_review', List<String> skipped = const [], bool ready = false, String licence = 'card_needed'}) => {
      'signed_up': true,
      'complete': next == 'pin' || ready,
      'owner_pin_set': ready,
      'ready_to_use': ready,
      'next': next == 'pin' ? null : next,
      'skipped': skipped,
      'pending': [if (identity != 'verified') 'identity'],
      'mode': 'capped',
      'limits': {'per_payment_minor': 25000, 'per_day_minor': 100000},
      'steps': {'business': business, 'identity': identity, 'stripe': stripe, 'licence': licence},
      'business': {'type': 'sole_trader', 'legal_name': 'Md Muzahidul Islam'},
      'business_types': [{'id': 'sole_trader', 'label': 'Sole trader'}],
      'requirements_due': 2,
      'checklist': {
        'rows': [
          {'id': 'id', 'label': 'Photo ID', 'done': true, 'due': 0},
          {'id': 'people', 'label': 'Owners and directors', 'done': true, 'due': 0},
          {'id': 'bank', 'label': 'Bank account for payouts', 'done': false, 'due': 1},
          {'id': 'business', 'label': 'Business details', 'done': true, 'due': 0},
          {'id': 'terms', 'label': "Stripe's terms", 'done': true, 'due': 0},
          {'id': 'cards', 'label': 'Card payments switched on', 'done': true, 'due': 0},
          {'id': 'payouts', 'label': 'Payouts to your bank switched on', 'done': false, 'due': 0},
        ],
        'other_due': 1,
        'stripe_reviewing': 0,
      },
      'licence': {'status': licence, 'trial_end': '2026-12-02T12:00:00Z', 'amount_minor': 2900, 'trial_days': 14},
    };

Future<void> _fonts() async {
  final root = '${Platform.environment['FLUTTER_ROOT'] ?? '/opt/fl/flutter'}/bin/cache/artifacts/material_fonts';
  Future<void> load(String family, List<String> files) async {
    final loader = FontLoader(family);
    for (final f in files) {
      final file = File('$root/$f');
      if (file.existsSync()) loader.addFont(Future.value(ByteData.view(file.readAsBytesSync().buffer)));
    }
    await loader.load();
  }
  await load('Roboto', ['Roboto-Regular.ttf', 'Roboto-Medium.ttf', 'Roboto-Bold.ttf', 'Roboto-Black.ttf']);
  await load('MaterialIcons', ['MaterialIcons-Regular.otf']);
}

void main() {
  final dir = Platform.environment['SHOTS'];
  setUpAll(() async {
    if (dir != null) await _fonts();
  });
  final cases = {
    'identity': _status(next: 'identity', stripe: 'not_started'),
    'stripe': _status(identity: 'via_connect'),
    'licence': _status(next: 'licence', identity: 'verified', stripe: 'complete', skipped: const []),
    'allset': _status(identity: 'verified', stripe: 'complete', licence: 'trialing', ready: true),
  };
  for (final e in cases.entries) {
    testWidgets('sign-up page: ${e.key}', (tester) async {
      tester.view.physicalSize = const Size(1640, 2360);
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      final key = GlobalKey();
      await tester.pumpWidget(ProviderScope(
        overrides: [apiProvider.overrideWithValue(_FakeApi(e.value))],
        child: RepaintBoundary(
          key: key,
          child: MaterialApp(theme: Tp.theme(Brightness.dark).copyWith(textTheme: Tp.theme(Brightness.dark).textTheme.apply(fontFamily: 'Roboto')), home: const OnboardingPage(gate: true)),
        ),
      ));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(seconds: 2));
      expect(tester.takeException(), isNull);
      if (dir == null) return;
      await tester.runAsync(() async {
        final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        File('$dir/${e.key}.png').writeAsBytesSync(bytes!.buffer.asUint8List());
      });
    });
  }
}
