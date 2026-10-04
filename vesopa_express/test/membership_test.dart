// Joining and renewing a membership at the kiosk, against a pretend server.
//
// The flow's state is set directly to put the first question up.
// ignore_for_file: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_express/data/api.dart';
import 'package:vesopa_express/data/models.dart';
import 'package:vesopa_express/data/order_flow.dart';
import 'package:vesopa_express/data/session.dart';
import 'package:vesopa_express/ui/app.dart';

const _config = KioskConfig(
  enabled: true,
  kioskId: 'k1',
  kioskName: 'Gym door',
  hasCardMachine: true,
  venueName: 'Iron Gym',
  accent: Color(0xFFA5C715),
  eatIn: true,
  takeAway: true,
  payCard: true,
  memberships: true,
);

class _FakeSession extends KioskSession {
  _FakeSession(this.initial);
  final KioskState initial;

  @override
  KioskState build() => initial;

  @override
  Future<void> refresh({bool withMenu = true}) async {}
}

/// The server, as far as these screens ask it anything.
class _FakeApi extends ExpressApi {
  final placed = <Map<String, Object?>>[];

  @override
  Future<List<MembershipPlan>> membershipPlans() async => const [
    MembershipPlan(id: 3, name: 'Gold', feeMinor: 3500, joiningFeeMinor: 1000, joinMinor: 4500, termMonths: 1),
  ];

  @override
  Future<MemberFound> findMember({String? cardNumber, String? email, String? phone, String? surname}) async {
    if (cardNumber != '4001') throw ExpressApiError(404, 'We could not find that membership.', code: 'member_not_found');
    return const MemberFound(
      token: 'tok', firstName: 'Ann', planName: 'Gold', state: 'active', expiry: '2026-11-04',
      renewMinor: 3500, canRenew: true,
    );
  }

  @override
  Future<OrderView> placeMembership({
    required String clientRef,
    required String kind,
    required String payment,
    String? memberToken,
    int? schemeId,
    String? name,
    String? email,
    String? phone,
  }) async {
    placed.add({'kind': kind, 'token': memberToken, 'payment': payment});
    return const OrderView(
      publicId: 'm1', number: 7, status: 'collected', stage: PayStage.paid, totalMinor: 3500,
      orderType: 'membership', customerName: 'Ann',
      membership: MembershipOutcome(kind: 'renew', planName: 'Gold', firstName: 'Ann', applied: true,
          expiry: '2026-12-04'),
    );
  }
}

Future<(ProviderContainer, _FakeApi)> _start(WidgetTester tester, Size size) async {
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final api = _FakeApi();
  await tester.pumpWidget(ProviderScope(
    overrides: [
      kioskSessionProvider.overrideWith(
          () => _FakeSession(const KioskState(phase: Phase.ready, config: _config, menu: KioskMenu.empty))),
      apiProvider.overrideWithValue(api),
    ],
    child: const ExpressApp(),
  ));
  await tester.pump();
  final container = ProviderScope.containerOf(tester.element(find.byType(ExpressApp)));
  container.read(orderFlowProvider.notifier).state = const FlowState(step: FlowStep.orderType);
  await tester.pump(const Duration(milliseconds: 400));
  return (container, api);
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  testWidgets('renew: scan or type the card, see who it is, pay, and be told the new date', (tester) async {
    final (container, api) = await _start(tester, const Size(1080, 1920));

    // ignore: avoid_print
    print(tester.widgetList<Text>(find.byType(Text)).map((t) => t.data).toList());
    expect(find.byKey(const ValueKey('choose-memberships')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('choose-memberships')));
    await _settle(tester);
    await tester.tap(find.byKey(const ValueKey('membership-renew')));
    await _settle(tester);

    for (final d in ['4', '0', '0', '1']) {
      await tester.tap(find.text(d).last);
      await tester.pump();
    }
    await tester.tap(find.text('Find'));
    await _settle(tester);

    expect(find.text('Hello, Ann'), findsOneWidget);
    expect(find.text('Runs to 04/11/2026'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('membership-pay-renew')));
    await _settle(tester);

    expect(api.placed.single, {'kind': 'renew', 'token': 'tok', 'payment': 'card'});
    expect(container.read(orderFlowProvider).step, FlowStep.done);
    expect(find.byKey(const ValueKey('membership-done')), findsOneWidget);
    expect(find.text('Your membership is renewed'), findsOneWidget);
    expect(find.text('Your Gold membership now runs to 04/12/2026.'), findsOneWidget);

    container.read(orderFlowProvider.notifier).reset();
    await tester.pump(const Duration(seconds: 16));
  });

  testWidgets('a card nobody holds says so, and nothing is paid for', (tester) async {
    final (_, api) = await _start(tester, const Size(1080, 1920));
    await tester.tap(find.byKey(const ValueKey('choose-memberships')));
    await _settle(tester);
    await tester.tap(find.byKey(const ValueKey('membership-renew')));
    await _settle(tester);
    await tester.tap(find.text('9').last);
    await tester.pump();
    await tester.tap(find.text('Find'));
    await _settle(tester);
    expect(find.byKey(const ValueKey('membership-error')), findsOneWidget);
    expect(api.placed, isEmpty);
  });

  for (final size in const [Size(1080, 1920), Size(1920, 1080), Size(540, 960), Size(960, 540)]) {
    testWidgets('join: the plans and the details form fit at ${size.width.toInt()}x${size.height.toInt()}',
        (tester) async {
      final (_, api) = await _start(tester, size);
      await tester.tap(find.byKey(const ValueKey('choose-memberships')));
      await _settle(tester);
      await tester.tap(find.byKey(const ValueKey('membership-join')));
      await _settle(tester);
      expect(find.text('Gold'), findsOneWidget);
      expect(find.text('£45.00'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('membership-plan-3')));
      await _settle(tester);
      expect(find.byKey(const ValueKey('membership-field-email')), findsOneWidget);
      // Nothing typed yet: nothing to pay.
      final pay = tester.widget<FilledButton>(find.byKey(const ValueKey('membership-pay-join')));
      expect(pay.onPressed, isNull);
      expect(api.placed, isEmpty);
    });
  }
}
