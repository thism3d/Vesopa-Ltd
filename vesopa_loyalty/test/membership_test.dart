import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_loyalty/data/api.dart';
import 'package:vesopa_loyalty/data/membership.dart';
import 'package:vesopa_loyalty/ui/membership_section.dart';

void main() {
  LoyaltyApi api(http.Response Function(http.Request) answer) =>
      LoyaltyApi(base: 'https://x.test', slug: 'gym', client: MockClient((r) async => answer(r)))..token = 't';

  test('a venue without memberships answers null, so the feature hides', () async {
    final a = api((_) => http.Response(jsonEncode({'error': 'Memberships are not offered here.'}), 404));
    expect(await a.membership(), isNull);
  });

  test('other failures still say why', () async {
    final a = api((_) => http.Response(jsonEncode({'error': 'Please sign in again.'}), 401));
    expect(a.membership(), throwsA(isA<ApiError>().having((e) => e.signedOut, 'signedOut', true)));
  });

  test('classes come back as a list, asked for a fortnight', () async {
    late Uri asked;
    final a = api((r) {
      asked = r.url;
      return http.Response(jsonEncode([{'id': 1, 'name': 'Spin'}]), 200);
    });
    final list = await a.classes();
    expect(asked.path, '/loyalty/v1/me/classes');
    expect(asked.queryParameters['days'], '14');
    expect(list.single['name'], 'Spin');
  });

  test('checkout sends the plan only when joining', () async {
    final bodies = <Map<String, dynamic>>[];
    final a = api((r) {
      bodies.add(jsonDecode(r.body) as Map<String, dynamic>);
      return http.Response(jsonEncode({'url': 'https://pay.dojo.tech/x', 'payment_id': 'p1', 'amount_minor': 4000}), 201);
    });
    await a.membershipCheckout(kind: 'join', schemeId: 3);
    await a.membershipCheckout(kind: 'renew');
    expect(bodies, [
      {'kind': 'join', 'scheme_id': 3},
      {'kind': 'renew'},
    ]);
  });

  test('membership state reads as words', () {
    expect(membershipStateText({'state': 'active', 'expiry': '2026-12-31', 'days_left': 90}), 'Active until 31 Dec 2026');
    expect(membershipStateText({'state': 'active', 'expiry': '2026-10-10', 'days_left': 6}),
        'Active until 10 Oct 2026 (6 days left)');
    expect(membershipStateText({'state': 'frozen', 'frozen_until': '2026-11-01'}), 'Frozen until 1 Nov 2026');
    expect(membershipStateText({'state': 'expired', 'expiry': '2026-09-01'}), 'Expired on 1 Sep 2026');
    expect(membershipStateText({'state': 'pending'}), 'Waiting for the venue to approve');
    expect(membershipStateText({'state': 'cancelled'}), 'Cancelled');
    expect(membershipStateText({'state': 'none'}), 'Not a member yet');
  });

  test('the Classes tab shows only where a plan includes classes', () {
    expect(offersClasses(null), isFalse);
    expect(offersClasses({'plan': {'includes_classes': false}, 'plans_for_sale': []}), isFalse);
    expect(offersClasses({'plan': {'includes_classes': true}}), isTrue);
    expect(offersClasses({'plan': null, 'plans_for_sale': [{'includes_classes': true}]}), isTrue);
  });

  test('classes group by day, in order, without finished or cancelled ones', () {
    final now = DateTime(2026, 10, 4, 12);
    final days = classesByDay([
      {'id': 1, 'starts_at': '2026-10-05T18:00', 'ends_at': '2026-10-05T19:00'},
      {'id': 2, 'starts_at': '2026-10-04T09:00', 'ends_at': '2026-10-04T10:00'},
      {'id': 3, 'starts_at': '2026-10-04T17:00', 'ends_at': '2026-10-04T18:00'},
      {'id': 4, 'starts_at': '2026-10-05T07:00', 'ends_at': '2026-10-05T08:00'},
      {'id': 5, 'starts_at': '2026-10-06T07:00', 'ends_at': '2026-10-06T08:00', 'cancelled': true},
      {'id': 6, 'starts_at': '2026-10-06T09:00', 'ends_at': '2026-10-06T10:00', 'cancelled': true, 'my_status': 'booked'},
    ], now);
    expect([for (final (_, l) in days) [for (final c in l) c['id']]], [
      [3],
      [4, 1],
      [6],
    ]);
    expect(classDayTitle(days[0].$1, now), 'Today');
    expect(classDayTitle(days[1].$1, now), 'Tomorrow');
    expect(classDayTitle(days[2].$1, now), 'Tuesday 6 Oct');
  });

  testWidgets('the membership card shows plan, state, family and prices', (tester) async {
    SharedPreferences.setMockInitialValues({});
    Future<void> tillRenew(BuildContext _) async {}
    await tester.pumpWidget(ProviderScope(
      child: MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: MembershipSection(
              tillRenew: tillRenew,
              membership: {
                'state': 'expired',
                'plan': {'id': 1, 'name': 'Gold', 'term_months': 12},
                'expiry': '2026-09-01',
                'member_number': '00042',
                'family': [
                  {'name': 'Ann', 'payer': true, 'state': 'expired'},
                  {'name': 'Ben', 'payer': false, 'state': 'expired'},
                ],
                'payer': true,
                'renew_minor': 3000,
                'can_pay_online': true,
                'plans_for_sale': [
                  {'id': 2, 'name': 'Silver', 'fee_minor': 2000, 'joining_fee_minor': 1000, 'join_minor': 3000, 'term_months': 12},
                ],
              },
            ),
          ),
        ),
      ),
    ));
    await tester.pump();
    expect(find.text('Gold'), findsOneWidget);
    expect(find.text('Expired on 1 Sep 2026'), findsOneWidget);
    expect(find.text('00042'), findsOneWidget);
    expect(find.text('Ann (pays)\nBen'), findsOneWidget);
    expect(find.text('Renew for £30.00'), findsOneWidget);
    expect(find.textContaining('£20.00 for 12 months + £10.00 joining fee'), findsOneWidget);
    expect(find.text('Join'), findsOneWidget);
  });
}
